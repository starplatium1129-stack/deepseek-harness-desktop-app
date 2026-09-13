// Titles are useful for navigation, but obvious credential strings must not be copied.
function redact(value) {
  return String(value).replace(/\bsk-[A-Za-z0-9_-]+/g, '[已隐藏密钥]')
    .replace(/(Bearer\s+)\S+/gi, '$1[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;}]+/gi, '$1[已隐藏]');
}
module.exports = { redact };
