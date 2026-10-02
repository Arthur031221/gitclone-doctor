const SAFE_CODES = new Set([
  'cancelled',
  'cleanup_failed',
  'config_output_limit',
  'config_read_failed',
  'demo_fixture_failed',
  'fixture_h2_unavailable',
  'fixture_protocol_mismatch',
  'home_unavailable',
  'invalid_arguments',
  'invalid_target',
  'netrc_check_failed',
  'netrc_present',
  'openssl_unavailable',
  'platform_unsupported',
  'proxy_unsupported',
  'setup_failed',
  'unsupported_http_version',
  'unsupported_node_version',
]);

export class DoctorError extends Error {
  constructor(code) {
    super(SAFE_CODES.has(code) ? code : 'setup_failed');
    this.name = 'DoctorError';
    this.code = SAFE_CODES.has(code) ? code : 'setup_failed';
  }
}

export function safeErrorCode(error) {
  return error instanceof DoctorError ? error.code : 'setup_failed';
}
