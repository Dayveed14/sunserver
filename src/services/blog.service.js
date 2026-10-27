import { HttpError } from '../lib/httpError.js';

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Article not found.');

export const slugify = (title) =>
  title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'article';

// A short plain-text summary for search results and link previews when the admin did not write one.
const autoSummary = (body) => body.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 155).replace(/\s\S*$/, '…');

export function createBlogService({ articlesModel, imagesModel = null, auditModel }) {
  async function uniqueSlug(title, exceptId = null) {
    const base = slugify(title);
    let slug = base;
    for (let n = 2; await articlesModel.slugTaken(slug, exceptId); n += 1) slug = `${base}-${n}`;
    return slug;
  }
  async function checkImage(imageId) {
    if (imageId == null) return;
    if (imagesModel && !(await imagesModel.exists?.(imageId))) throw new HttpError(400, 'VALIDATION_ERROR', 'That picture could not be found. Upload it again.');
  }

  return {
    // ---- public ----
    async list(opts) {
      return { articles: await articlesModel.listPublished(opts) };
    },
    async get(slug) {
      const a = await articlesModel.findPublishedBySlug(String(slug).slice(0, 120));
      if (!a) throw notFound();
      return { article: a };
    },
    // ---- admin ----
    adminList: async () => ({ articles: await articlesModel.listAll() }),
    async adminGet(id) {
      const a = await articlesModel.findById(id);
      if (!a) throw notFound();
      return { article: a };
    },
    async create(adminId, data) {
      await checkImage(data.imageId);
      const id = await articlesModel.create({ ...data, summary: data.summary || autoSummary(data.body), slug: await uniqueSlug(data.title), authorId: adminId });
      await auditModel.add({ adminId, action: 'blog.create', target: `article:${id}`, detail: { title: data.title, status: data.status } });
      return { article: await articlesModel.findById(id) };
    },
    async update(adminId, id, data) {
      const cur = await articlesModel.findById(id);
      if (!cur) throw notFound();
      await checkImage(data.imageId);
      // The address stays the same once an article is live, so links people shared keep working.
      const slug = cur.status === 'published' && cur.publishedAt ? cur.slug : await uniqueSlug(data.title, id);
      await articlesModel.update(id, { ...data, summary: data.summary || autoSummary(data.body), slug });
      await auditModel.add({ adminId, action: 'blog.update', target: `article:${id}`, detail: { title: data.title, status: data.status } });
      return { article: await articlesModel.findById(id) };
    },
    async remove(adminId, id) {
      const cur = await articlesModel.findById(id);
      if (!cur || !(await articlesModel.remove(id))) throw notFound();
      await auditModel.add({ adminId, action: 'blog.delete', target: `article:${id}`, detail: { title: cur.title } });
    },
  };
}
