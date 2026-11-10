// What an installer tells us when they register. The same lists drive the form, the checks and the admin's review.
export const BUSINESS_STATUS = [
  { id: 'cac', label: 'CAC registered' },
  { id: 'none', label: 'Not registered' },
  { id: 'other', label: 'Other registration' },
];
export const TRAVEL_KM = [
  { id: 10, label: 'Up to 10 km' },
  { id: 25, label: 'Up to 25 km' },
  { id: 50, label: 'Up to 50 km' },
  { id: 100, label: 'More than 50 km' },
];
// years is the low end of the band, kept in installer_profiles.years_experience for sorting and the old screens.
export const EXPERIENCE = [
  { id: 'lt1', label: 'Less than 1 year', years: 0 },
  { id: 'y1_3', label: '1–3 years', years: 1 },
  { id: 'y4_6', label: '4–6 years', years: 4 },
  { id: 'y7_10', label: '7–10 years', years: 7 },
  { id: 'gt10', label: 'More than 10 years', years: 11 },
];
export const QUALIFICATION = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
  { id: 'training', label: 'Currently in training' },
];
export const PROJECT_TYPES = [
  { id: 'residential', label: 'Homes' },
  { id: 'small_commercial', label: 'Shops and small businesses' },
  { id: 'large_commercial', label: 'Large commercial sites' },
  { id: 'industrial', label: 'Industrial sites' },
  { id: 'maintenance', label: 'Maintenance and repairs' },
];
export const CAPACITY = [1, 2, 3, 5, 10];
export const RESPONSE_TIME = [
  { id: '1h', label: 'Within an hour' },
  { id: '4h', label: 'Within a few hours' },
  { id: '24h', label: 'Within a day' },
  { id: '48h', label: 'Within two days' },
];
export const MIN_REFERENCES = 2;
export const MAX_REFERENCES = 3;
// Optional uploads, and how many of each. None of them is needed to be approved: skill matters more than papers.
export const INSTALLER_DOC_KINDS = { photo: 1, work: 6, certificate: 3 };

export const registrationOptions = () => ({
  businessStatus: BUSINESS_STATUS, travelKm: TRAVEL_KM, experience: EXPERIENCE.map(({ id, label }) => ({ id, label })),
  qualification: QUALIFICATION, projectTypes: PROJECT_TYPES, capacity: CAPACITY, responseTime: RESPONSE_TIME,
  minReferences: MIN_REFERENCES, maxReferences: MAX_REFERENCES, docLimits: INSTALLER_DOC_KINDS,
});

const ok = (v) => v !== null && v !== undefined && v !== '';

// What is still missing before the registration can be sent. Returns plain section names the form can point to.
export function missingForSubmit({ profile, references, quizSubmitted }) {
  const missing = [];
  if (!ok(profile.businessStatus) || !ok(profile.travelKm)) missing.push('about');
  if (!ok(profile.experienceBand) || !ok(profile.qualification) || !(profile.projectTypes?.length > 0)) missing.push('experience');
  if (!ok(profile.capacity) || !ok(profile.responseTime)) missing.push('capacity');
  if (!quizSubmitted) missing.push('skills');
  if ((references?.length ?? 0) < MIN_REFERENCES) missing.push('references');
  return missing;
}
