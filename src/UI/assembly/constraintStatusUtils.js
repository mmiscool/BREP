export function constraintStatusInfo(entry) {
  const pd = entry?.persistentData || {};
  const status = pd.status || 'Idle';
  const out = { label: '', title: '', error: false };

  if (status === 'unimplemented') {
    out.label = 'Unimplemented';
    out.title = pd.message || 'Constraint solver not implemented yet.';
    out.error = true;
    return out;
  }

  if (status === 'satisfied') {
    out.label = 'Satisfied';
    out.title = pd.message || 'Constraint satisfied within tolerance.';
    return out;
  }

  if (status === 'adjusted') {
    out.label = 'Adjusting';
    out.title = pd.message || 'Constraint nudging components toward the solution.';
    return out;
  }

  if (status === 'blocked') {
    out.label = 'Blocked';
    out.title = pd.message || 'Constraint cannot adjust locked components.';
    out.error = true;
    return out;
  }

  if (status === 'pending') {
    out.label = 'Pending';
    out.title = pd.message || 'Constraint awaiting convergence.';
    return out;
  }

  if (status === 'error') {
    out.label = 'Error';
    out.title = pd.message || 'Constraint evaluation failed.';
    out.error = true;
    return out;
  }

  if (status === 'applied' || status === 'computed') {
    const delta = Array.isArray(pd.lastDelta)
      ? pd.lastDelta.map((v) => Number(v).toFixed(3)).join(', ')
      : null;
    out.label = status === 'applied' ? 'Applied' : 'Pending';
    if (delta) out.label += ` · Δ[${delta}]`;
    if (Array.isArray(pd.lastAppliedMoves) && pd.lastAppliedMoves.length) {
      const summary = pd.lastAppliedMoves
        .map((move) => {
          if (!move || !Array.isArray(move.move)) return null;
          const vec = move.move.map((v) => Number(v).toFixed(3)).join(', ');
          return `${move.element}: [${vec}]`;
        })
        .filter(Boolean)
        .join(' | ');
      if (summary) out.title = summary;
    }
    return out;
  }

  if (status === 'incomplete') {
    out.label = 'Incomplete';
    out.title = 'Select the required components to define the constraint.';
    return out;
  }

  if (status === 'invalid-selection') {
    out.label = 'Invalid selection';
    out.title = 'Unable to resolve world positions for selections.';
    out.error = true;
    return out;
  }

  if (status === 'pending-component') {
    out.label = 'Pending component';
    out.title = 'Offset stored but no component selected to move.';
    return out;
  }

  if (status === 'fixed') {
    out.label = 'Locked';
    out.title = pd.message || 'Both components are fixed; nothing moved.';
    return out;
  }

  if (status === 'noop') {
    out.label = 'No change';
    out.title = pd.message || 'Selections already satisfy this constraint.';
    return out;
  }

  if (status === 'apply-failed') {
    out.label = 'Failed';
    out.title = pd.error || 'Apply failed';
    out.error = true;
    return out;
  }

  if (status && status !== 'Idle') {
    out.label = status.charAt(0).toUpperCase() + status.slice(1);
    if (pd.message) out.title = pd.message;
  }

  return out;
}
