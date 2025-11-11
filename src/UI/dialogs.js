
const overlayStyle = {
    position: 'fixed',
    inset: '0',
    background: 'rgba(0,0,0,.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '10000',
};

const dialogStyle = {
    // Centered within overlay
    position: 'relative',
    background: 'var(--bg-elev, #12141b)',
    color: 'var(--text, #e6e6e6)',
    padding: '14px',
    boxShadow: '0 10px 40px rgba(0,0,0,.5)',
    borderRadius: '12px',
    border: '1px solid var(--border, #262b36)',
    fontSize: '14px',
    lineHeight: '1.4',
    textAlign: 'left',
    width: 'min(480px, calc(100vw - 32px))',
    maxWidth: '100%',
};

// Buttons follow the app's neutral button style; the "confirm" style is the emphasized/primary look.
const neutralButtonStyle = {
    appearance: 'none',
    border: '1px solid var(--border, #262b36)',
    background: 'linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))',
    color: 'var(--text, #e6e6e6)',
    borderRadius: '10px',
    padding: '8px 12px',
    fontWeight: '700',
    fontSize: '12px',
    cursor: 'pointer',
};

const emphasizedButtonStyle = {
    ...neutralButtonStyle,
    border: '1px solid var(--focus, #3b82f6)',
    boxShadow: '0 0 0 3px rgba(59,130,246,.15)'
};

// Keep variable names used below; map to our neutral/emphasized styles.
const confirmButtonStyle = emphasizedButtonStyle;   // used for the default/emphasized action
const cancelButtonStyle = neutralButtonStyle;       // used for the secondary action



window.confirm = async (message, timeoutInSeconds = null, defaultValue = false) => {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        const dialog = document.createElement('div');
        const messageDiv = document.createElement('div');
        const countdownDiv = document.createElement('div');
        const buttonContainer = document.createElement('div');
        const confirmButton = document.createElement('button');
        const cancelButton = document.createElement('button');

        // Overlay + dialog styles
        Object.assign(overlay.style, overlayStyle);
        Object.assign(dialog.style, dialogStyle);

        messageDiv.textContent = message;
        // preformatted text and spacing
        messageDiv.style.whiteSpace = 'pre-wrap';
        messageDiv.style.marginBottom = '8px';
        messageDiv.style.color = 'var(--text, #e6e6e6)';

        // Countdown indicator
        if (timeoutInSeconds && timeoutInSeconds > 0) {
            countdownDiv.textContent = `Time remaining: ${timeoutInSeconds} seconds`;
            countdownDiv.style.marginBottom = '8px';
            countdownDiv.style.fontSize = '12px';
            countdownDiv.style.color = 'var(--muted, #9aa4b2)';
            dialog.appendChild(countdownDiv);
        }

        confirmButton.textContent = 'Yes';
        cancelButton.textContent = 'No';


        // Highlight default button
        if (defaultValue) {
            Object.assign(confirmButton.style, confirmButtonStyle);
            Object.assign(cancelButton.style, cancelButtonStyle);
        } else {
            Object.assign(confirmButton.style, cancelButtonStyle);
            Object.assign(cancelButton.style, confirmButtonStyle);
        }

        // Button container styling
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';
        buttonContainer.style.marginTop = '12px';

        buttonContainer.appendChild(confirmButton);
        buttonContainer.appendChild(cancelButton);

        dialog.appendChild(messageDiv);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        let timeout = null;
        let countdownInterval = null;

        if (timeoutInSeconds && timeoutInSeconds > 0) {
            timeout = setTimeout(() => {
                cleanup();
                resolve(defaultValue);
            }, timeoutInSeconds * 1000);

            // Update countdown every second
            let remainingTime = timeoutInSeconds;
            countdownInterval = setInterval(() => {
                remainingTime -= 1;
                if (remainingTime <= 0) {
                    clearInterval(countdownInterval);
                }
                countdownDiv.textContent = `Time remaining: ${remainingTime} seconds`;
            }, 1000);
        }

        const cleanup = () => {
            if (timeout) clearTimeout(timeout); // Clear the timeout if it exists
            if (countdownInterval) clearInterval(countdownInterval); // Clear the countdown interval
            confirmButton.removeEventListener('click', onConfirm);
            cancelButton.removeEventListener('click', onCancel);
            try { overlay.remove(); } catch (_) { try { dialog.remove(); } catch (_) {} }
        };

        const onConfirm = () => {
            cleanup(); // Ensure dialog is removed first
            resolve(true); // Then resolve the promise
        };

        const onCancel = () => {
            cleanup(); // Ensure dialog is removed first
            resolve(false); // Then resolve the promise
        };

        confirmButton.addEventListener('click', onConfirm);
        cancelButton.addEventListener('click', onCancel);
    });
};




window.alert = async (message, timeoutInSeconds = null) => {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        const dialog = document.createElement('div');
        const messageDiv = document.createElement('div');
        const countdownDiv = document.createElement('div');
        const buttonContainer = document.createElement('div');
        const okButton = document.createElement('button');

        // Set up styles
        Object.assign(overlay.style, overlayStyle);
        Object.assign(dialog.style, dialogStyle);

        messageDiv.textContent = message;
        // set style to preformatted text
        messageDiv.style.whiteSpace = 'pre-wrap';
        messageDiv.style.marginBottom = '8px';
        messageDiv.style.color = 'var(--text, #e6e6e6)';

        // Countdown indicator
        if (timeoutInSeconds && timeoutInSeconds > 0) {
            countdownDiv.textContent = `Time remaining: ${timeoutInSeconds} seconds`;
            countdownDiv.style.marginBottom = '8px';
            countdownDiv.style.fontSize = '12px';
            countdownDiv.style.color = 'var(--muted, #9aa4b2)';
            dialog.appendChild(countdownDiv);
        }

        okButton.textContent = 'OK';
        Object.assign(okButton.style, confirmButtonStyle);

        // Button container styling
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';
        buttonContainer.style.marginTop = '12px';

        buttonContainer.appendChild(okButton);

        dialog.appendChild(messageDiv);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        let timeout = null;
        let countdownInterval = null;

        if (timeoutInSeconds && timeoutInSeconds > 0) {
            timeout = setTimeout(() => {
                cleanup();
                resolve();
            }, timeoutInSeconds * 1000);

            // Update countdown every second
            let remainingTime = timeoutInSeconds;
            countdownInterval = setInterval(() => {
                remainingTime -= 1;
                if (remainingTime <= 0) {
                    clearInterval(countdownInterval);
                }
                countdownDiv.textContent = `Time remaining: ${remainingTime} seconds`;
            }, 1000);
        }

        const cleanup = () => {
            if (timeout) clearTimeout(timeout); // Clear the timeout if it exists
            if (countdownInterval) clearInterval(countdownInterval); // Clear the countdown interval
            okButton.removeEventListener('click', onOk);
            try { overlay.remove(); } catch (_) { try { dialog.remove(); } catch (_) {} }
        };

        const onOk = () => {
            cleanup(); // Ensure dialog is removed first
            resolve(); // Then resolve the promise
        };

        okButton.addEventListener('click', onOk);
    });
};




window.prompt = async (message, defaultValue = '') => {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        const dialog = document.createElement('div');
        const messageDiv = document.createElement('div');
        const inputField = document.createElement('input');
        const buttonContainer = document.createElement('div');
        const okButton = document.createElement('button');
        const cancelButton = document.createElement('button');

        // Set up styles
        Object.assign(overlay.style, overlayStyle);
        Object.assign(dialog.style, dialogStyle);

        messageDiv.textContent = message;
        messageDiv.style.whiteSpace = 'pre-wrap';
        messageDiv.style.marginBottom = '8px';
        messageDiv.style.color = 'var(--text, #e6e6e6)';

        inputField.type = 'text';
        inputField.value = defaultValue;
        inputField.style.width = '100%';
        inputField.style.boxSizing = 'border-box';
        inputField.style.padding = '8px 10px';
        inputField.style.border = '1px solid var(--border, #262b36)';
        inputField.style.borderRadius = '10px';
        inputField.style.marginBottom = '10px';
        inputField.style.fontSize = '14px';
        inputField.style.background = 'var(--input-bg, #0b0e14)';
        inputField.style.color = 'var(--text, #e6e6e6)';
        inputField.style.outline = 'none';

        okButton.textContent = 'OK';
        Object.assign(okButton.style, confirmButtonStyle);
        cancelButton.textContent = 'Cancel';
        Object.assign(cancelButton.style, cancelButtonStyle);

        buttonContainer.appendChild(okButton);
        buttonContainer.appendChild(cancelButton);

        // Button container styling
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '8px';
        buttonContainer.style.marginTop = '4px';

        dialog.appendChild(messageDiv);
        dialog.appendChild(inputField);
        dialog.appendChild(buttonContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        inputField.focus();

        const cleanup = () => {
            okButton.removeEventListener('click', onOk);
            cancelButton.removeEventListener('click', onCancel);
            inputField.removeEventListener('keydown', onEnter);
            try { overlay.remove(); } catch (_) { try { dialog.remove(); } catch (_) {} }
        };

        const onOk = () => {
            cleanup();
            resolve(inputField.value); // Resolve with the value entered
        };

        const onCancel = () => {
            cleanup();
            resolve(null); // Resolve with null for cancel
        };

        const onEnter = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                onOk();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
            }
        };

        okButton.addEventListener('click', onOk);
        cancelButton.addEventListener('click', onCancel);
        inputField.addEventListener('keydown', onEnter);
    });
};
