import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_REFERENCES, missingForSubmit, registrationOptions } from '../src/utils/installerRegistration.js';
import { referenceCheckSchema, referencesSchema, registrationPatchSchema, submitRegistrationSchema } from '../src/validators/installerRegistration.schemas.js';

const full = {
  businessStatus: 'none', travelKm: 25, experienceBand: 'y4_6', qualification: 'no', projectTypes: ['residential'],
  capacity: 2, responseTime: '4h',
};
const refs = [{ name: 'A' }, { name: 'B' }];

test('a complete registration has nothing missing', () => {
  assert.deepEqual(missingForSubmit({ profile: full, references: refs, quizSubmitted: true }), []);
});

test('each missing part is named, so the form can point to it', () => {
  assert.deepEqual(missingForSubmit({ profile: {}, references: [], quizSubmitted: false }), ['about', 'experience', 'capacity', 'skills', 'references']);
  assert.deepEqual(missingForSubmit({ profile: { ...full, projectTypes: [] }, references: refs, quizSubmitted: true }), ['experience']);
  assert.deepEqual(missingForSubmit({ profile: full, references: refs.slice(0, MIN_REFERENCES - 1), quizSubmitted: true }), ['references']);
  assert.deepEqual(missingForSubmit({ profile: { ...full, travelKm: null }, references: refs, quizSubmitted: true }), ['about']);
});

test('uploads, the about text and the repairs switch are optional', () => {
  assert.deepEqual(missingForSubmit({ profile: { ...full, about: null, acceptsRepairs: undefined }, references: refs, quizSubmitted: true }), []);
});

test('the form gets every list it needs and no individual / team choice exists', () => {
  const o = registrationOptions();
  for (const k of ['businessStatus', 'travelKm', 'experience', 'qualification', 'projectTypes', 'capacity', 'responseTime']) assert.ok(o[k].length > 0, k);
  assert.equal(o.experience.length, 5);
  assert.equal('providerType' in o, false);
  assert.equal('team' in o, false);
});

test('a step can be saved on its own, with only valid values', () => {
  assert.equal(registrationPatchSchema.safeParse({}).success, true);
  assert.equal(registrationPatchSchema.safeParse({ capacity: 3, responseTime: '24h', acceptsRepairs: false }).success, true);
  for (const bad of [{ capacity: 4 }, { travelKm: 7 }, { responseTime: 'soon' }, { businessStatus: 'team' }, { projectTypes: ['residential', 'residential'] }, { about: 'x'.repeat(1001) }, { verification: 'verified' }, { flowVersion: 1 }]) {
    assert.equal(registrationPatchSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test('references: Nigerian numbers are normalised, others refused, at most three', () => {
  const r = referencesSchema.parse({ references: [{ name: 'Mr Ade', phone: '0803 123 4567', relationship: 'Past client' }] });
  assert.equal(r.references[0].phone, '+2348031234567');
  assert.equal(referencesSchema.safeParse({ references: [{ name: 'Mr Ade', phone: '12345', relationship: 'Past client' }] }).success, false);
  assert.equal(referencesSchema.safeParse({ references: [{ name: 'M', phone: '08031234567', relationship: 'Past client' }] }).success, false);
  const one = { name: 'Mr Ade', phone: '08031234567', relationship: 'Past client' };
  assert.equal(referencesSchema.safeParse({ references: [one, one, one, one] }).success, false);
});

test('sending the registration needs the box ticked; the admin tick needs a yes or no', () => {
  assert.equal(submitRegistrationSchema.safeParse({ declaration: true }).success, true);
  assert.equal(submitRegistrationSchema.safeParse({ declaration: false }).success, false);
  assert.equal(submitRegistrationSchema.safeParse({}).success, false);
  assert.equal(referenceCheckSchema.safeParse({ called: true, note: 'Spoke to him' }).success, true);
  assert.equal(referenceCheckSchema.safeParse({ note: 'x' }).success, false);
});
