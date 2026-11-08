// Seed data for a fresh install. Everything here is editable in the app.

export const TRACKS = {
  tattoo: 'Brow tattoo',
  lash: 'Lashes',
  brow: 'Brow styling',
  none: 'Not tracked',
};

/**
 * followUps: what is due next after this service, in days from the visit.
 * When several follow-ups have passed, the latest one wins (e.g. a missed
 * perfecting session turns into a yearly touch-up after 12 months).
 * lateAfterDays/latePrice: price switch when the previous visit in the same
 * track is older than lateAfterDays (touch-up before/after 12 months).
 */
const s = (id, name, track, durationMin, price, keywords, followUps = [], extra = {}) =>
  ({ id, name, track, durationMin, price, keywords, followUps, active: true, ...extra });

export const DEFAULT_SERVICES = [
  s('mb', 'Brow microblading', 'tattoo', 150, 400,
    'microblading, microblade, micro blading, mb, feathering, feather touch, new brows, full brows, first session',
    [{ serviceId: 'perfect', days: 42 }, { serviceId: 'touchup', days: 365 }], { priority: 30 }),
  s('perfect', 'Brow perfecting session', 'tattoo', 90, 150,
    'perfecting, perfect, 2nd session, second session, follow up, follow-up',
    [{ serviceId: 'touchup', days: 323 }], { priority: 50 }),
  s('brow-extra', 'Brow session (if needed)', 'tattoo', 90, 100,
    '3rd session, third session, third free session, extra session',
    [{ serviceId: 'touchup', days: 300 }], { priority: 60 }),
  s('touchup', 'Brow touch-up', 'tattoo', 90, 200,
    'touch up, touch-up, touchup, tu, top up, topup, yearly, annual, colour boost, color boost, refresh',
    [{ serviceId: 'touchup', days: 365 }], { lateAfterDays: 365, latePrice: 250, priority: 40 }),
  s('mb-other', 'Microblading (after another artist)', 'tattoo', 150, 300,
    'other artist, different artist, correction, cover up, cover-up',
    [{ serviceId: 'perfect', days: 42 }, { serviceId: 'touchup', days: 365 }], { priority: 35 }),

  s('shape-tint', 'Brow shape & tint', 'brow', 30, 30,
    'brow shape, shape and tint, shape & tint, shape&tint, brow tint, wax and tint, tint, brows, brow wax, shape, brow tidy, obrvi', [{ serviceId: 'shape-tint', days: 42 }]),
  s('shape-henna', 'Brow shape & henna stain', 'brow', 35, 45, 'henna', [{ serviceId: 'shape-henna', days: 42 }]),
  s('shape-lam', 'Brow shape & lamination', 'brow', 40, 50, 'lamination, laminate, brow lam', [{ serviceId: 'shape-lam', days: 56 }]),
  s('shape-lam-henna', 'Brow shape, lamination & henna', 'brow', 60, 85,
    'lamination and henna, lamination & henna, lam henna', [{ serviceId: 'shape-lam-henna', days: 56 }]),

  s('lash-tint', 'Lash tint', 'lash', 20, 20, 'lash tint, eyelash tint', [{ serviceId: 'lash-tint', days: 42 }]),
  s('lash-lift', 'Lash lift & tint', 'lash', 45, 75, 'lash lift, lashlift, lash-lift, lift, lift and tint, lll',
    [{ serviceId: 'lash-lift', days: 56 }], { priority: 20 }),

  s('beautiful', 'Beautiful Eyes (lash tint, brow shape & tint)', 'brow', 45, 45, 'beautiful eyes', [{ serviceId: 'beautiful', days: 42 }]),
  s('divine', 'Divine Eyes (lash lift, brow shape & tint)', 'lash', 60, 95, 'divine eyes, divine', [{ serviceId: 'divine', days: 56 }]),
  s('gorgeous', 'Gorgeous Eyes (lash lift, brow shape & henna)', 'lash', 70, 110, 'gorgeous eyes, gorgeous', [{ serviceId: 'gorgeous', days: 56 }]),
  s('majestic', 'Majestic Eyes (lash lift, brow shape & lamination)', 'lash', 70, 115, 'majestic eyes, majestic', [{ serviceId: 'majestic', days: 56 }]),
  s('stunning', 'Stunning Eyes (lash lift, brow shape, lamination & henna)', 'lash', 90, 150, 'stunning eyes, stunning', [{ serviceId: 'stunning', days: 56 }]),

  // Not offered on the current price list, kept so old calendar entries import cleanly.
  s('consult', 'Consultation', 'none', 30, 0, 'consultation, consult', [], { priority: -1 }),
  s('other', 'Other beauty (waxing, nails, facials)', 'none', 60, 0,
    'wax, waxing, brazilian, brazillian, bikini, underarm, legs, leg wax, nails, nohtki, gel, toes, facial, lip, make up, makeup, eyes, pedicure, manicure, mani, pedi',
    [], { priority: -2, active: false }),
];

export const DEFAULT_TEMPLATES = [
  { id: 'confirm', name: 'Booking confirmation',
    body: "Hi {first}, you're booked in for {service} on {day} at {time}. If you need to change it, please give 24 hours' notice. Thanks, {sign}" },
  { id: 'reminder', name: 'Appointment reminder',
    body: 'Hi {first}, just a reminder of your {service} appointment {when} ({day}) at {time}. Reply to confirm, or let me know if you need to reschedule. {sign}' },
  { id: 'due', name: 'Follow-up due',
    body: "Hi {first}, it's coming up to time for your {due} (your last visit was {lastDate}). Would you like me to book you in? Let me know what days suit. {sign}" },
  { id: 'thanks', name: 'Thank you / aftercare',
    body: 'Hi {first}, thank you for coming in today! Please follow your aftercare instructions and get in touch if you have any questions. {sign}' },
  { id: 'payment', name: 'Payment reminder',
    body: 'Hi {first}, a friendly note that {outstanding} is still owing for your {service} on {date}. Thanks, {sign}' },
];

export const DEFAULT_SETTINGS = {
  businessName: 'Browlicious',
  signature: 'Browlicious',
  dueWindowDays: 14,        // show "due soon" this many days ahead
  lapseAfterDays: 365,      // overdue longer than this = lapsed (hidden from home)
  googleClientId: '',
  calendarSync: false,
  calendarId: 'primary',
  importFrom: '2015-01-01',
  driveBackup: false,
  backupIntervalHours: 24,
  backupKeep: 30,
  driveFolderId: null,
  lastBackupAt: null,
  lastLocalExportAt: null,
  lastCalendarSyncAt: null,
  // Tags she can tap on a client (editable in Settings).
  clientTags: ['Reminder set', 'Waiting for reply', 'Call back', 'VIP', 'Do not book'],
};
