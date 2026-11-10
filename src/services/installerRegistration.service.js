import { randomBytes } from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { MAX_DOCUMENT_BYTES, sniffDocument } from '../utils/documents.js';
import { sniffImage } from '../utils/images.js';
import { EXPERIENCE, INSTALLER_DOC_KINDS, missingForSubmit, registrationOptions } from '../utils/installerRegistration.js';

const notFound = (what) => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
// After approval an installer can still keep their working details up to date, but not rewrite who they are.
const EDITABLE_WHEN_APPROVED = ['travelKm', 'capacity', 'responseTime', 'acceptsRepairs', 'projectTypes', 'about'];

// The installer's own registration: the details, two references and the optional photos and certificate.
export function createInstallerRegistrationService({ registrationModel, documentsModel, usersModel, cloudinary, notifier }) {
  const docsFor = async (userId) => (await documentsModel.listFor(userId)).filter((d) => d.kind in INSTALLER_DOC_KINDS);

  async function load(userId) {
    const profile = await registrationModel.get(userId);
    if (!profile) throw notFound('Installer');
    return profile;
  }

  async function overview(userId) {
    const profile = await load(userId);
    const [references, documents] = await Promise.all([registrationModel.listReferences(userId), docsFor(userId)]);
    const quizSubmitted = Boolean(profile.quizSubmittedAt);
    const missing = missingForSubmit({ profile, references, quizSubmitted });
    return {
      options: registrationOptions(),
      verification: profile.verification,
      note: profile.verificationNote,
      submitted: Boolean(profile.registrationSubmittedAt),
      registration: {
        businessStatus: profile.businessStatus, travelKm: profile.travelKm, experienceBand: profile.experienceBand,
        qualification: profile.qualification, about: profile.about, projectTypes: profile.projectTypes,
        capacity: profile.capacity, responseTime: profile.responseTime, acceptsRepairs: profile.acceptsRepairs,
      },
      references: references.map(({ id, name, phone, relationship }) => ({ id, name, phone, relationship })),
      documents,
      quizSubmitted,
      missing,
      canSubmit: profile.verification !== 'verified' && missing.length === 0 && !(profile.verification === 'pending' && profile.registrationSubmittedAt),
    };
  }

  return {
    overview,

    async save(userId, patch) {
      const profile = await load(userId);
      if (profile.verification === 'verified') {
        const blocked = Object.keys(patch).filter((k) => !EDITABLE_WHEN_APPROVED.includes(k));
        if (blocked.length) throw new HttpError(409, 'ALREADY_VERIFIED', 'You are approved, so those details are locked. Contact us if something has changed.');
      }
      const years = patch.experienceBand ? EXPERIENCE.find((e) => e.id === patch.experienceBand)?.years ?? null : null;
      await registrationModel.save(userId, patch, years);
      return overview(userId);
    },

    async saveReferences(userId, references) {
      const profile = await load(userId);
      if (profile.verification === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'You are already approved.');
      const phones = references.map((r) => r.phone);
      if (new Set(phones).size !== phones.length) throw new HttpError(400, 'VALIDATION_ERROR', 'Each reference needs a different phone number.', { fields: { references: 'Each reference needs a different phone number.' } });
      const me = await usersModel.findById(userId);
      if (me?.phone && phones.includes(me.phone)) throw new HttpError(400, 'VALIDATION_ERROR', 'A reference cannot be your own number.', { fields: { references: 'A reference cannot be your own number.' } });
      await registrationModel.replaceReferences(userId, references);
      return overview(userId);
    },

    // Optional files. A photo or work picture must be an image; a certificate may also be a PDF.
    async uploadDocument(userId, { body, kind, label }) {
      if (!(kind in INSTALLER_DOC_KINDS)) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose what this file is.');
      const profile = await load(userId);
      if (profile.verification === 'verified' && kind === 'certificate') throw new HttpError(409, 'ALREADY_VERIFIED', 'You are already approved.');
      const mime = kind === 'certificate' ? sniffDocument(body) : sniffImage(body);
      if (!mime) throw new HttpError(400, 'INVALID_DOCUMENT', kind === 'certificate' ? 'Upload a PDF, JPEG, PNG or WebP file.' : 'Upload a JPEG, PNG or WebP picture.');
      if (body.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'DOCUMENT_TOO_LARGE', 'That file is too large (4 MB at most).');
      const existing = (await docsFor(userId)).filter((d) => d.kind === kind);
      if (kind === 'photo') {
        // One profile photo: a new one replaces the old.
        for (const d of existing) await this.deleteDocument(userId, d.id);
      } else if (existing.length >= INSTALLER_DOC_KINDS[kind]) {
        throw new HttpError(409, 'TOO_MANY_DOCUMENTS', `You can add up to ${INSTALLER_DOC_KINDS[kind]} of these. Remove one first.`);
      }
      let remote = null;
      if (cloudinary.enabled) {
        try {
          remote = await cloudinary.upload(body, mime, `solalium/kyc/${randomBytes(12).toString('hex')}`);
        } catch (err) {
          console.error('[installer] Cloudinary upload failed:', err.message);
          throw new HttpError(502, 'UPLOAD_FAILED', 'We could not save that file. Please try again.');
        }
      }
      const id = await documentsModel.create({ userId, kind, label: label?.slice(0, 120) || null, mime, size: body.length, data: body, remote, resourceType: 'image' });
      return { id };
    },

    async deleteDocument(userId, id) {
      const profile = await load(userId);
      const doc = (await docsFor(userId)).find((d) => d.id === id);
      if (!doc) throw notFound('File');
      if (profile.verification === 'verified' && doc.kind === 'certificate') throw new HttpError(409, 'ALREADY_VERIFIED', 'Approved certificates cannot be removed.');
      const gone = await documentsModel.remove(id, userId);
      if (gone?.publicId && cloudinary.enabled) cloudinary.destroy(gone.publicId).catch(() => {});
    },

    async submit(userId) {
      const state = await overview(userId);
      if (state.verification === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'You are already approved.');
      if (state.verification === 'pending' && state.submitted) throw new HttpError(409, 'ALREADY_SUBMITTED', 'You have already sent your registration. We will email you when it has been reviewed.');
      if (state.missing.length) throw new HttpError(400, 'REGISTRATION_INCOMPLETE', 'Please finish every step first.', { missing: state.missing });
      await registrationModel.markSubmitted(userId);
      const u = await usersModel.findById(userId);
      await notifier.notify('installer_quiz_submitted', { who: u?.full_name ?? u?.email ?? `installer ${userId}` });
      return overview(userId);
    },
  };
}
