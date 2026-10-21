// The two states Sunledger delivers in for now, with the areas people pick from.
// zone: "Central" = the core business and residential districts, "Inner" = built-up districts around it,
// "Outer" = the edges and satellite towns. Coordinates are approximate area centres, used only to estimate
// distance for delivery pricing and delivery times. They are not survey data.
export const STATES = [
  { id: 'lagos', name: 'Lagos' },
  { id: 'abuja', name: 'Abuja (FCT)' },
];

const A = (id, name, zone, lat, lng) => ({ id, name, zone, lat, lng });

const AREAS = {
  lagos: [
    A('victoria-island', 'Victoria Island', 'Central', 6.4281, 3.4219),
    A('ikoyi', 'Ikoyi', 'Central', 6.4549, 3.4366),
    A('lagos-island', 'Lagos Island', 'Central', 6.4549, 3.3947),
    A('oniru', 'Oniru', 'Central', 6.4344, 3.4528),
    A('lekki-phase-1', 'Lekki Phase 1', 'Central', 6.4478, 3.4723),
    A('yaba', 'Yaba', 'Central', 6.5095, 3.3711),
    A('surulere', 'Surulere', 'Central', 6.4969, 3.3556),
    A('ebute-metta', 'Ebute Metta', 'Central', 6.4786, 3.3797),
    A('apapa', 'Apapa', 'Central', 6.4478, 3.359),
    A('ikeja', 'Ikeja', 'Central', 6.6018, 3.3515),
    A('ikeja-gra', 'Ikeja GRA', 'Central', 6.587, 3.3446),
    A('maryland', 'Maryland', 'Central', 6.5667, 3.3646),
    A('ilupeju', 'Ilupeju', 'Inner', 6.5539, 3.3583),
    A('gbagada', 'Gbagada', 'Inner', 6.5536, 3.386),
    A('ojota', 'Ojota', 'Inner', 6.5833, 3.3833),
    A('ketu', 'Ketu', 'Inner', 6.5972, 3.3855),
    A('magodo', 'Magodo', 'Inner', 6.62, 3.392),
    A('ogba', 'Ogba', 'Inner', 6.6272, 3.3412),
    A('ojodu-berger', 'Ojodu / Berger', 'Inner', 6.641, 3.3534),
    A('oshodi', 'Oshodi', 'Inner', 6.556, 3.343),
    A('mushin', 'Mushin', 'Inner', 6.5268, 3.356),
    A('isolo', 'Isolo', 'Inner', 6.524, 3.317),
    A('ajegunle', 'Ajegunle', 'Inner', 6.456, 3.335),
    A('festac', 'Festac Town', 'Inner', 6.4647, 3.2842),
    A('lekki-phase-2', 'Lekki Phase 2 / Chevron', 'Inner', 6.441, 3.517),
    A('ikate', 'Ikate / Elegushi', 'Inner', 6.439, 3.48),
    A('agege', 'Agege', 'Inner', 6.618, 3.321),
    A('ajah', 'Ajah', 'Outer', 6.4698, 3.5852),
    A('sangotedo', 'Sangotedo', 'Outer', 6.47, 3.637),
    A('ibeju-lekki', 'Ibeju-Lekki', 'Outer', 6.46, 3.78),
    A('ikorodu', 'Ikorodu', 'Outer', 6.6194, 3.5105),
    A('alimosho', 'Alimosho / Egbeda', 'Outer', 6.593, 3.277),
    A('igando', 'Igando / Ikotun', 'Outer', 6.58, 3.24),
    A('abule-egba', 'Abule Egba', 'Outer', 6.65, 3.287),
    A('ojo', 'Ojo', 'Outer', 6.4667, 3.1833),
    A('epe', 'Epe', 'Outer', 6.584, 3.983),
    A('badagry', 'Badagry', 'Outer', 6.415, 2.883),
  ],
  abuja: [
    A('cbd', 'Central Business District', 'Central', 9.0579, 7.4891),
    A('garki', 'Garki', 'Central', 9.0333, 7.49),
    A('wuse', 'Wuse', 'Central', 9.0667, 7.4833),
    A('wuse-2', 'Wuse 2', 'Central', 9.0765, 7.4698),
    A('maitama', 'Maitama', 'Central', 9.0888, 7.4948),
    A('asokoro', 'Asokoro', 'Central', 9.045, 7.529),
    A('jabi', 'Jabi', 'Central', 9.075, 7.418),
    A('utako', 'Utako', 'Central', 9.068, 7.433),
    A('mabushi', 'Mabushi', 'Central', 9.087, 7.457),
    A('wuye', 'Wuye', 'Central', 9.0693, 7.4531),
    A('gudu', 'Gudu', 'Central', 9.029, 7.465),
    A('durumi', 'Durumi', 'Central', 9.025, 7.461),
    A('gwarinpa', 'Gwarinpa', 'Inner', 9.112, 7.4),
    A('life-camp', 'Life Camp', 'Inner', 9.099, 7.417),
    A('jahi', 'Jahi', 'Inner', 9.097, 7.42),
    A('kado', 'Kado', 'Inner', 9.095, 7.433),
    A('katampe', 'Katampe', 'Inner', 9.11, 7.46),
    A('apo', 'Apo', 'Inner', 8.9948, 7.5107),
    A('lokogoma', 'Lokogoma', 'Inner', 8.96, 7.453),
    A('galadimawa', 'Galadimawa', 'Inner', 8.99, 7.43),
    A('dutse', 'Dutse', 'Inner', 9.115, 7.347),
    A('idu', 'Idu', 'Inner', 9.065, 7.38),
    A('mpape', 'Mpape', 'Inner', 9.13, 7.49),
    A('airport-road', 'Airport Road', 'Inner', 8.99, 7.38),
    A('kubwa', 'Kubwa', 'Outer', 9.155, 7.327),
    A('lugbe', 'Lugbe', 'Outer', 8.9786, 7.3793),
    A('nyanya', 'Nyanya', 'Outer', 9.03, 7.575),
    A('karu', 'Karu', 'Outer', 9.02, 7.59),
    A('zuba', 'Zuba', 'Outer', 9.0885, 7.2155),
    A('bwari', 'Bwari', 'Outer', 9.283, 7.382),
    A('kuje', 'Kuje', 'Outer', 8.879, 7.241),
    A('gwagwalada', 'Gwagwalada', 'Outer', 8.942, 7.078),
  ],
};

export const ZONES = ['Central', 'Inner', 'Outer'];
export const stateIds = () => STATES.map((s) => s.id);
export const areasOf = (stateId) => AREAS[stateId] ?? [];
export const findArea = (stateId, areaId) => areasOf(stateId).find((a) => a.id === areaId) ?? null;
export const stateName = (stateId) => STATES.find((s) => s.id === stateId)?.name ?? null;
export const allAreas = () => Object.entries(AREAS).flatMap(([state, list]) => list.map((a) => ({ ...a, state })));

// What the app shows in drop-downs (no coordinates).
export const publicGeo = () => ({
  states: STATES.map((s) => ({
    ...s,
    areas: areasOf(s.id).map(({ id, name, zone }) => ({ id, name, zone })),
  })),
  zones: ZONES,
});
