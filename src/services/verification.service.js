import { randomBytes } from 'node:crypto';
import { HttpError } from '../lib/httpError.js';
import { DOCUMENT_KINDS, MAX_DOCUMENT_BYTES, requiredKinds, sniffDocument } from '../utils/documents.js';
import { publicQuiz, scoreQuiz, validQuizAnswers } from '../utils/installerQuiz.js';
import { MIN_REFERENCES, INSTALLER_DOC_KINDS, registrationOptions } from '../utils/installerRegistration.js';

const MAX_DOCS = 8;
const notFound = (what) => new HttpError(404, 'NOT_FOUND', `${what} not found.`);

// Vendor document checks and installer vetting. Only the owner and the admin can ever read a document.
export function createVerificationService({ vendorsModel, installersModel, installerRegistrationModel, documentsModel, usersModel, auditModel, cloudinary, notifier }) {
  const who = (p) => p.companyName ?? p.contactName ?? p.email;

  async function vendorStatus(userId) {
    const p = await vendorsModel.getProfile(userId);
    if (!p) throw notFound('Vendor');
    const documents = await documentsModel.listFor(userId);
    const need = requiredKinds(p.vendorType);
    const missing = need.filter((k) => !documents.some((d) => d.kind === k));
    return {
      vendorType: p.vendorType, status: p.verification, note: p.note, submittedAt: p.submittedAt, verifiedAt: p.verifiedAt,
      documents, required: need, missing,
      canSubmit: p.verification !== 'verified' && documents.length > 0 && missing.length === 0 && !(p.verification === 'pending' && p.submittedAt),
      instructions: p.vendorType === 'company'
        ? 'Upload your CAC certificate (required) and any other company documents, such as a tax certificate or your director\'s ID.'
        : 'Upload proof that you run a shop or business: a photo of the shop, a market or association card, or a business registration.',
    };
  }

  return {
    vendorStatus,

    async uploadDocument(userId, { body, kind, label }) {
      if (!DOCUMENT_KINDS.includes(kind)) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose what kind of document this is.');
      const p = await vendorsModel.getProfile(userId);
      if (!p) throw notFound('Vendor');
      if (p.verification === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'You are already verified.');
      const mime = sniffDocument(body);
      if (!mime) throw new HttpError(400, 'INVALID_DOCUMENT', 'Upload a PDF, JPEG, PNG or WebP file.');
      if (body.length > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'DOCUMENT_TOO_LARGE', 'That file is too large (4 MB at most).');
      if ((await documentsModel.count(userId)) >= MAX_DOCS) throw new HttpError(409, 'TOO_MANY_DOCUMENTS', 'You have reached the limit of documents. Remove one first.');
      let remote = null;
      if (cloudinary.enabled) {
        try {
          // A random folder keeps the address unguessable; the file is only ever handed out by our own checked endpoint.
          remote = await cloudinary.upload(body, mime, `solalium/kyc/${randomBytes(12).toString('hex')}`);
        } catch (err) {
          console.error('[verification] Cloudinary upload failed:', err.message);
          throw new HttpError(502, 'UPLOAD_FAILED', 'We could not save that file. Please try again.');
        }
      }
      const id = await documentsModel.create({ userId, kind, label: label?.slice(0, 120) || null, mime, size: body.length, data: body, remote, resourceType: 'image' });
      return { id };
    },

    async deleteDocument(userId, id) {
      const p = await vendorsModel.getProfile(userId);
      if (p?.verification === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'Verified documents cannot be removed.');
      const gone = await documentsModel.remove(id, userId);
      if (!gone) throw notFound('Document');
      if (gone.publicId && cloudinary.enabled) cloudinary.destroy(gone.publicId).catch(() => {});
    },

    async submit(userId) {
      const status = await vendorStatus(userId);
      if (status.status === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'You are already verified.');
      if (status.missing.length) throw new HttpError(400, 'DOCUMENTS_MISSING', `Please upload your ${status.missing.map((k) => k.toUpperCase()).join(', ')} first.`);
      if (!status.documents.length) throw new HttpError(400, 'DOCUMENTS_MISSING', 'Upload at least one document first.');
      const p = await vendorsModel.getProfile(userId);
      await vendorsModel.markSubmitted(userId);
      await notifier.notify('verification_submitted', { who: who(p), kind: p.vendorType === 'company' ? 'Company vendor' : 'Seller' });
      return vendorStatus(userId);
    },

    // The owner, or the admin, reads one file. Everyone else gets "not found" so ids cannot be probed.
    async documentFile(requester, id) {
      const f = await documentsModel.file(id);
      if (!f || (requester.role !== 'admin' && f.userId !== requester.id)) throw notFound('Document');
      return f;
    },

    // ---- admin: vendors ----
    async vendorReview(vendorId) {
      const p = await vendorsModel.getProfile(vendorId);
      if (!p) throw notFound('Vendor');
      return { vendor: { ...p, userId: vendorId }, documents: await documentsModel.listFor(vendorId), required: requiredKinds(p.vendorType) };
    },

    async decideVendor(adminId, vendorId, { status, note }) {
      const p = await vendorsModel.getProfile(vendorId);
      if (!p) throw notFound('Vendor');
      if (status === 'rejected' && !note?.trim()) throw new HttpError(400, 'VALIDATION_ERROR', 'Say why, so the vendor knows what to fix.');
      if (status === 'verified') {
        const docs = await documentsModel.listFor(vendorId);
        const missing = requiredKinds(p.vendorType).filter((k) => !docs.some((d) => d.kind === k));
        if (missing.length) throw new HttpError(409, 'DOCUMENTS_MISSING', `This vendor has not uploaded: ${missing.join(', ')}.`);
      }
      await vendorsModel.setVerification(vendorId, status, note?.trim() || null);
      await auditModel.add({ adminId, action: 'vendor.verification', target: `vendor:${vendorId}`, detail: { from: p.verification, to: status, note: note?.trim() || null } });
      if (status !== 'pending') await notifier.notify('verification_decided', { user: { email: p.email, fullName: p.contactName }, approved: status === 'verified', note: note?.trim(), subject: p.companyName });
      return { userId: vendorId, verification: status };
    },

    // ---- installers ----
    async installerSummary(userId) {
      const p = await installersModel.getProfile(userId);
      if (!p) throw notFound('Installer');
      return {
        verification: p.verification, note: p.note, quizSubmitted: Boolean(p.quizSubmittedAt), yearsExperience: p.yearsExperience,
        registrationSubmitted: Boolean(p.registrationSubmittedAt), acceptsRepairs: p.acceptsRepairs,
      };
    },

    // The installer sees the questions only. No score and no right answers ever leave the server.
    async quiz(userId) {
      const p = await installersModel.getProfile(userId);
      if (!p) throw notFound('Installer');
      return { questions: publicQuiz(), submitted: Boolean(p.quizSubmittedAt), verification: p.verification };
    },

    async submitQuiz(userId, { answers, yearsExperience }) {
      const p = await installersModel.getProfile(userId);
      if (!p) throw notFound('Installer');
      if (p.verification === 'verified') throw new HttpError(409, 'ALREADY_VERIFIED', 'You are already approved.');
      if (p.quizSubmittedAt && p.verification === 'pending') throw new HttpError(409, 'QUIZ_SUBMITTED', 'You have already sent your answers. We will email you when they are reviewed.');
      if (!validQuizAnswers(answers)) throw new HttpError(400, 'VALIDATION_ERROR', 'Please answer every question.');
      const { score, total } = scoreQuiz(answers);
      if (yearsExperience != null) await installersModel.setExperience(userId, yearsExperience);
      await installersModel.saveAttempt({ userId, answers, score, total });
      // Installers on the new registration are reported to the admin when they send the whole registration, not at this step.
      if (p.flowVersion < 2) {
        const u = await usersModel.findById(userId);
        await notifier.notify('installer_quiz_submitted', { who: u?.full_name ?? u?.email ?? `installer ${userId}` });
      }
      return { submitted: true };
    },

    // The admin records that they phoned a reference (or takes the tick back).
    async checkReference(adminId, installerId, refId, { called, note }) {
      const done = await installerRegistrationModel.markCalled(installerId, refId, adminId, called, note?.trim());
      if (!done) throw notFound('Reference');
      await auditModel.add({ adminId, action: 'installer.reference', target: `installer:${installerId}`, detail: { refId, called, note: note?.trim() || null } });
      return { references: await installerRegistrationModel.listReferences(installerId) };
    },

    async listInstallers({ status }) {
      return { installers: await installersModel.listForAdmin({ status }) };
    },

    async installerReview(installerId) {
      const p = await installersModel.getProfile(installerId);
      if (!p) throw notFound('Installer');
      const attempt = await installersModel.latestAttempt(installerId);
      const u = await usersModel.findById(installerId);
      const [registration, references, documents] = await Promise.all([
        installerRegistrationModel.get(installerId),
        installerRegistrationModel.listReferences(installerId),
        documentsModel.listFor(installerId),
      ]);
      const options = registrationOptions();
      const label = (list, id) => list.find((o) => o.id === id)?.label ?? null;
      return {
        installer: { userId: installerId, name: u?.full_name, email: u?.email, phone: u?.phone, state: u?.address_state, ...p },
        quiz: attempt ? { ...scoreQuiz(attempt.answers), submittedAt: attempt.createdAt } : null,
        registration: registration && {
          flowVersion: registration.flowVersion, submittedAt: registration.registrationSubmittedAt,
          business: label(options.businessStatus, registration.businessStatus), travelKm: registration.travelKm,
          experience: label(options.experience, registration.experienceBand), qualification: label(options.qualification, registration.qualification),
          about: registration.about, projectTypes: (registration.projectTypes ?? []).map((id) => label(options.projectTypes, id)).filter(Boolean),
          capacity: registration.capacity, responseTime: label(options.responseTime, registration.responseTime), acceptsRepairs: registration.acceptsRepairs,
        },
        references,
        documents: documents.filter((d) => d.kind in INSTALLER_DOC_KINDS),
      };
    },

    async decideInstaller(adminId, installerId, { status, note }) {
      const p = await installersModel.getProfile(installerId);
      if (!p) throw notFound('Installer');
      if (status === 'rejected' && !note?.trim()) throw new HttpError(400, 'VALIDATION_ERROR', 'Say why, so the installer knows what to do next.');
      if (status === 'verified' && !p.quizSubmittedAt) throw new HttpError(409, 'QUIZ_MISSING', 'This installer has not answered the questions yet.');
      if (status === 'verified' && p.flowVersion >= 2) {
        // New registrations: sent for review, two references, and every reference phoned by us first.
        if (!p.registrationSubmittedAt) throw new HttpError(409, 'REGISTRATION_MISSING', 'This installer has not finished the registration yet.');
        const refs = await installerRegistrationModel.listReferences(installerId);
        if (refs.length < MIN_REFERENCES) throw new HttpError(409, 'REFERENCES_MISSING', `This installer needs at least ${MIN_REFERENCES} references.`);
        if (refs.some((r) => !r.calledAt)) throw new HttpError(409, 'REFERENCES_NOT_CALLED', 'Phone every reference and tick it off before approving.');
      }
      await installersModel.setVerification(installerId, status, note?.trim() || null);
      await auditModel.add({ adminId, action: 'installer.verification', target: `installer:${installerId}`, detail: { from: p.verification, to: status, note: note?.trim() || null } });
      const u = await usersModel.findById(installerId);
      if (u && status !== 'pending') await notifier.notify('verification_decided', { user: { email: u.email, fullName: u.full_name }, approved: status === 'verified', note: note?.trim(), subject: 'TerraVoltix installer' });
      return { userId: installerId, verification: status };
    },
  };
}
