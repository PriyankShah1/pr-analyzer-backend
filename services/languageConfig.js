// services/languageConfig.js
//
// Single source of truth for AI explanation languages.
// To add a new language in future: add ONE entry below. Nothing else
// in the codebase needs to change — aiService.js, routes/explain.js,
// and the frontend AIExplanation.tsx all read this config dynamically.

const SUPPORTED_LANGUAGES = {

  en: {
    label: 'English',
    nativeLabel: 'English',
    isDefault: true, // auto-generated on every /analyze call
    styleInstruction: `Write in clear, standard technical English. This is for an
experienced developer doing code review — be direct and precise.`,
  },

  hinglish: {
    label: 'Hinglish',
    nativeLabel: 'Hinglish',
    isDefault: false, // generated on-demand only
    styleInstruction: `Write in Hinglish — the way Indian developers naturally talk
to each other. Keep ALL technical terms in English exactly as-is: function,
controller, service, parameter, return type, mismatch, route, middleware,
database, etc. Only the connecting grammar, sentence structure, and explanation
flow should be in casual Hindi, written in Roman script (NOT Devanagari).
Do NOT translate technical words into Hindi. Example of the correct register:
"Ye PR user login ka flow add karta hai. Route POST /login se
LoginController@authenticate call hota hai, jo AuthService@validateCredentials
ko call karta hai. Ek type mismatch hai — controller request object pass kar
raha hai lekin service object expect kar raha hai, isse runtime error aa
sakta hai." Match this exact style and register.`,
  },

  marathi: {
    label: 'Marathi',
    nativeLabel: 'मराठी',
    isDefault: false,
    styleInstruction: `Write in Marathi-English code-mixed style, the way Marathi
developers naturally talk to each other. Keep ALL technical terms in English
exactly as-is: function, controller, service, parameter, return type,
mismatch, route, middleware, database, etc. Only the connecting grammar and
sentence flow should be in casual Marathi, written in Roman script (NOT
Devanagari). Do NOT translate technical words into Marathi. Example of the
correct register: "Ha PR user login cha flow add karto. Route POST /login
made LoginController@authenticate call hoto, jo AuthService@validateCredentials
la call karto. Ek type mismatch ahe — controller request object pass karto
pan service object expect karte, yamule runtime error yeu shakte." Match this
exact style and register.`,
  },

  tamil: {
    label: 'Tamil',
    nativeLabel: 'தமிழ்',
    isDefault: false,
    styleInstruction: `Write in Tamil-English code-mixed style (Tanglish), the
way Tamil developers naturally talk to each other. Keep ALL technical terms
in English exactly as-is: function, controller, service, parameter, return
type, mismatch, route, middleware, database, etc. Only the connecting
grammar and sentence flow should be in casual Tamil, written in Roman script
(NOT Tamil script). Do NOT translate technical words into Tamil. Example of
the correct register: "Indha PR user login flow add pannudhu. Route POST
/login la irundhu LoginController@authenticate call aagudhu, adhu
AuthService@validateCredentials ah call pannudhu. Oru type mismatch irukku —
controller request object pass pannudhu aana service object expect
pannudhu, idhal runtime error varalam." Match this exact style and register.`,
  },

  // ── To add a new language, copy this block and fill in: ────────────────
  // code: {
  //   label: 'Display Name',
  //   nativeLabel: 'Native script name (or same as label)',
  //   isDefault: false,
  //   styleInstruction: `...style guide + one example sentence...`,
  // },

};

function isSupportedLanguage(code) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, code);
}

function getLanguageConfig(code) {
  return SUPPORTED_LANGUAGES[code] || null;
}

function getDefaultLanguage() {
  const entry = Object.entries(SUPPORTED_LANGUAGES).find(([, cfg]) => cfg.isDefault);
  return entry ? entry[0] : 'en';
}

// Used by GET /explain/languages — frontend builds its tabs from this
function listSupportedLanguages() {
  return Object.entries(SUPPORTED_LANGUAGES).map(([code, cfg]) => ({
    code,
    label: cfg.label,
    nativeLabel: cfg.nativeLabel,
    isDefault: cfg.isDefault,
  }));
}

module.exports = {
  SUPPORTED_LANGUAGES,
  isSupportedLanguage,
  getLanguageConfig,
  getDefaultLanguage,
  listSupportedLanguages,
};