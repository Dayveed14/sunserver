// People who want to hear when an energy category launches. Public, email only, and it never says whether an email was already there.
export function createInterestService({ model }) {
  return {
    async add({ category, email }) {
      await model.add(category, email);
      return { ok: true };
    },
    summary: () => model.summary(),
  };
}
