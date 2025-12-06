export class AssemblyConstraintControlsWidget {
  constructor(host) {
    this.host = host || null;
    this.element = this.#buildControlsPanel();
  }

  #buildControlsPanel() {
    const wrap = document.createElement('div');
    wrap.className = 'constraints-control-panel';

    wrap.appendChild(this.#buildSolverControls());
    wrap.appendChild(this.#buildVisualizationControls());
    wrap.appendChild(this.#buildDebugControls());

    return wrap;
  }

  #buildSolverControls() {
    const host = this.host;
    const wrap = document.createElement('div');
    wrap.className = 'control-panel-section solver-controls';

    const mainRow = document.createElement('div');
    mainRow.className = 'solver-row solver-row-main';

    const label = document.createElement('label');
    label.className = 'solver-iterations';

    const labelText = document.createElement('span');
    labelText.className = 'solver-iterations-label';
    labelText.textContent = 'Iterations';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.inputMode = 'numeric';
    input.value = String(host?._defaultIterations ?? 1);
    input.style.width = '5em';
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 1) {
        input.value = String(host?._defaultIterations ?? 1);
      }
    });

    label.appendChild(labelText);
    label.appendChild(input);

    const buttonGroup = document.createElement('div');
    buttonGroup.className = 'solver-button-group';

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'btn solver-start-btn';
    startBtn.textContent = 'Start';
    startBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const promise = host?._handleStartClick?.call(host);
      if (promise?.catch) {
        try { promise.catch(() => { }); } catch { /* ignore */ }
      }
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'btn solver-stop-btn';
    stopBtn.textContent = 'Stop';
    stopBtn.disabled = true;
    stopBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const stopPromise = host?._stopSolver?.call(host, { wait: false });
      if (stopPromise?.catch) {
        try { stopPromise.catch(() => { }); } catch { /* ignore */ }
      }
    });

    buttonGroup.appendChild(startBtn);
    buttonGroup.appendChild(stopBtn);

    mainRow.appendChild(label);
    mainRow.appendChild(buttonGroup);

    const statusRow = document.createElement('div');
    statusRow.className = 'solver-row solver-row-status';

    const statusLabel = document.createElement('span');
    statusLabel.className = 'solver-status-label';
    statusLabel.textContent = 'Status: Idle';

    const loopLabel = document.createElement('span');
    loopLabel.className = 'solver-loop-label';
    loopLabel.textContent = 'Loop: -';

    const constraintLabel = document.createElement('span');
    constraintLabel.className = 'solver-constraint-label';
    constraintLabel.textContent = 'Constraint: -';

    statusRow.appendChild(statusLabel);
    statusRow.appendChild(loopLabel);
    statusRow.appendChild(constraintLabel);

    const autoSolveRow = document.createElement('div');
    autoSolveRow.className = 'solver-row solver-row-autosolve';

    const autoSolveLabel = document.createElement('label');
    autoSolveLabel.className = 'toggle-control solver-autosolve-toggle';

    const autoSolveCheckbox = document.createElement('input');
    autoSolveCheckbox.type = 'checkbox';
    autoSolveCheckbox.checked = !!host?._fullSolveOnChange;
    autoSolveCheckbox.addEventListener('change', () => {
      host?._handleFullSolveToggleChange?.call(host, autoSolveCheckbox.checked);
    });

    const autoSolveText = document.createElement('span');
    autoSolveText.textContent = 'Full solve on change';

    autoSolveLabel.appendChild(autoSolveCheckbox);
    autoSolveLabel.appendChild(autoSolveText);
    autoSolveRow.appendChild(autoSolveLabel);

    const animateRow = document.createElement('div');
    animateRow.className = 'solver-row solver-row-animate';

    const animateLabel = document.createElement('label');
    animateLabel.className = 'toggle-control solver-animate-toggle';

    const animateCheckbox = document.createElement('input');
    animateCheckbox.type = 'checkbox';
    animateCheckbox.checked = host?._animateEnabled !== false;
    animateCheckbox.addEventListener('change', () => {
      host?._handleAnimateCheckboxChange?.call(host);
    });

    const animateText = document.createElement('span');
    animateText.textContent = 'Animate solve';

    animateLabel.appendChild(animateCheckbox);
    animateLabel.appendChild(animateText);

    const delayContainer = document.createElement('div');
    delayContainer.className = 'solver-animate-delay';

    const delayLabel = document.createElement('span');
    delayLabel.textContent = 'Step speed (ms)';

    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = '0';
    delayInput.step = '1';
    delayInput.inputMode = 'numeric';
    delayInput.value = String(host?._animateDelayMs ?? 0);
    delayInput.addEventListener('change', () => {
      host?._handleAnimateDelayChange?.call(host);
    });

    delayContainer.appendChild(delayLabel);
    delayContainer.appendChild(delayInput);

    animateRow.appendChild(animateLabel);
    animateRow.appendChild(delayContainer);

    const pauseRow = document.createElement('div');
    pauseRow.className = 'solver-row solver-row-pause';

    const pauseLabel = document.createElement('label');
    pauseLabel.className = 'toggle-control solver-pause-toggle';

    const pauseCheckbox = document.createElement('input');
    pauseCheckbox.type = 'checkbox';
    pauseCheckbox.addEventListener('change', () => {
      host?._handlePauseCheckboxChange?.call(host);
    });

    const pauseText = document.createElement('span');
    pauseText.textContent = 'Pause between loops';

    pauseLabel.appendChild(pauseCheckbox);
    pauseLabel.appendChild(pauseText);

    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'btn solver-continue-btn';
    continueBtn.textContent = 'Continue';
    continueBtn.disabled = true;
    continueBtn.style.display = 'none';
    continueBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      host?._handleContinueClick?.call(host);
    });

    pauseRow.appendChild(pauseLabel);
    pauseRow.appendChild(continueBtn);

    wrap.appendChild(mainRow);
    wrap.appendChild(statusRow);
    wrap.appendChild(autoSolveRow);
    wrap.appendChild(animateRow);
    wrap.appendChild(pauseRow);

    if (host) {
      host._iterationInput = input;
      host._startButton = startBtn;
      host._stopButton = stopBtn;
      host._solverStatusLabel = statusLabel;
      host._solverLoopLabel = loopLabel;
      host._solverConstraintLabel = constraintLabel;
      host._pauseCheckbox = pauseCheckbox;
      host._solverContinueButton = continueBtn;
      host._animateCheckbox = animateCheckbox;
      host._animateDelayInput = delayInput;
      host._animateDelayContainer = delayContainer;
      host._fullSolveCheckbox = autoSolveCheckbox;
      host._animateEnabled = animateCheckbox.checked !== false;
      host._updateSolverUI?.();
    }

    return wrap;
  }

  #buildVisualizationControls() {
    const host = this.host;
    const wrap = document.createElement('div');
    wrap.className = 'control-panel-section visualization-controls';

    const label = document.createElement('label');
    label.className = 'toggle-control';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = host?._constraintGraphicsEnabled ?? false;
    checkbox.addEventListener('change', () => {
      host?._setConstraintGraphicsEnabled?.call(host, checkbox.checked);
    });

    const span = document.createElement('span');
    span.textContent = 'Show Constraint Graphics';

    label.appendChild(checkbox);
    label.appendChild(span);
    wrap.appendChild(label);

    if (host) {
      host._constraintGraphicsCheckbox = checkbox;
    }

    return wrap;
  }

  #buildDebugControls() {
    const host = this.host;
    const wrap = document.createElement('div');
    wrap.className = 'control-panel-section debug-controls';

    const label = document.createElement('label');
    label.className = 'toggle-control';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('change', () => {
      host?._handleDebugCheckboxChange?.call(host, checkbox.checked);
    });

    const span = document.createElement('span');
    span.textContent = 'Debug Normals';

    label.appendChild(checkbox);
    label.appendChild(span);
    wrap.appendChild(label);

    return wrap;
  }

  dispose() {
    this.host = null;
    this.element = null;
  }
}
