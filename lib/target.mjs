import { DoctorError } from './errors.mjs';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}$/;

function makeTarget(owner, repository) {
  if (!OWNER.test(owner) || !REPOSITORY.test(repository) || repository === '.' || repository === '..') {
    throw new DoctorError('invalid_target');
  }

  return Object.freeze({
    owner,
    repository,
    name: `${owner}/${repository}`,
    url: `https://github.com/${owner}/${repository}.git`,
  });
}

export function parseTarget(input) {
  if (typeof input !== 'string' || input.length === 0 || input !== input.trim() || /[\u0000-\u0020\u007f%]/.test(input)) {
    throw new DoctorError('invalid_target');
  }

  if (input.startsWith('https://')) {
    if (/[?#]/.test(input)) throw new DoctorError('invalid_target');

    const authority = input.match(/^https:\/\/([^/]+)/i)?.[1];
    if (!authority || authority.toLowerCase() !== 'github.com') throw new DoctorError('invalid_target');

    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      throw new DoctorError('invalid_target');
    }

    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new DoctorError('invalid_target');
    }

    const rawPath = input.slice(`https://${authority}`.length);
    if (rawPath.includes('\\') || rawPath !== parsed.pathname || !rawPath.startsWith('/')) throw new DoctorError('invalid_target');
    const segments = rawPath.slice(1).split('/');
    if (segments.length !== 2 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
      throw new DoctorError('invalid_target');
    }
    return makeTarget(segments[0], segments[1].endsWith('.git') ? segments[1].slice(0, -4) : segments[1]);
  }

  if (input.includes('://') || input.includes('/') && input.split('/').length !== 2) {
    throw new DoctorError('invalid_target');
  }

  const parts = input.split('/');
  if (parts.length !== 2) throw new DoctorError('invalid_target');
  return makeTarget(parts[0], parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1]);
}
