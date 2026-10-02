export function classifyResults(probes, requestedHttpVersion) {
  const targetCurrentPassed = probes.targetSelected.ok;
  if (targetCurrentPassed) {
    return {
      code: 'refs_discovered',
      message: 'Anonymous ref discovery passed with the selected target settings.',
      exitCode: 0,
    };
  }

  if (probes.targetHttp1.ok) {
    if (requestedHttpVersion === 'HTTP/1.1') {
      return {
        code: 'inconsistent_results',
        message: 'The two HTTP/1.1 attempts differed. Timing or transient conditions may explain the comparison.',
        exitCode: 1,
      };
    }
    return {
      code: 'http1_retry_passed',
      message: 'The HTTP/1.1 retry succeeded. Timing or transient conditions may explain the comparison.',
      exitCode: 1,
    };
  }

  if (probes.controlSelected.ok && probes.controlHttp1.ok) {
    return {
      code: 'target_access_or_url',
      message: 'Both target requests failed while both control requests passed. Check the target URL or access; this does not establish a credential problem.',
      exitCode: 1,
    };
  }

  if (!probes.targetSelected.ok && !probes.targetHttp1.ok && !probes.controlSelected.ok && !probes.controlHttp1.ok) {
    return {
      code: 'shared_failure',
      message: 'All four Git requests failed. The shared cause remains unresolved.',
      exitCode: 1,
    };
  }

  return {
    code: 'inconclusive',
    message: 'The results are mixed and do not isolate a cause.',
    exitCode: 1,
  };
}
