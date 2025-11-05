
const dialogStyle = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    backgroundColor: 'rgba(0,0,0,0.8)', // Partly transparent black
    color: '#fff',
    padding: '20px',
    boxShadow: '0 4px 8px rgba(0,0,0,0.2)',
    borderRadius: '8px',
    zIndex: '1000',
    fontSize: '18px', // Medium font size
    textAlign: 'left',
    zIndex: '10000'
};

const confirmButtonStyle = {
    padding: '10px 20px',
    margin: '10px',
    backgroundColor: '#4CAF50', // Green
    color: '#fff',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
};

const cancelButtonStyle = {
    padding: '10px 20px',
    margin: '10px',
    backgroundColor: '#f44336', // Red
    color: '#fff',
    border: 'none',
    borderRadius: '5px',
    cursor: 'pointer',
};



window.confirm = async (message, timeoutInSeconds = null, defaultValue = false) => {
    return new Promise((resolve) => {
        const dialog = document.createElement('div');
        const messageDiv = document.createElement('div');
        const countdownDiv = document.createElement('div');
        const buttonContainer = document.createElement('div');
        const confirmButton = document.createElement('button');
        const cancelButton = document.createElement('button');

        // apply styles from dialogStyle using Object.assign
        Object.assign(dialog.style, dialogStyle);


        messageDiv.textContent = message;
        // set style to preformatted text
        messageDiv.style.whiteSpace = 'pre-wrap';

        // Countdown indicator
        if (timeoutInSeconds && timeoutInSeconds > 0) {
            countdownDiv.textContent = `Time remaining: ${timeoutInSeconds} seconds`;
            countdownDiv.style.marginBottom = '10px';
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

        buttonContainer.appendChild(confirmButton);
        buttonContainer.appendChild(cancelButton);

        dialog.appendChild(messageDiv);
        dialog.appendChild(buttonContainer);
        document.body.appendChild(dialog);

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
            dialog.remove(); // Remove the dialog from the DOM
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
        const dialog = document.createElement('div');
        const messageDiv = document.createElement('div');
        const countdownDiv = document.createElement('div');
        const buttonContainer = document.createElement('div');
        const okButton = document.createElement('button');

        // Set up styles
        Object.assign(dialog.style, dialogStyle);

        messageDiv.textContent = message;
        // set style to preformatted text
        messageDiv.style.whiteSpace = 'pre-wrap';

        // Countdown indicator
        if (timeoutInSeconds && timeoutInSeconds > 0) {
            countdownDiv.textContent = `Time remaining: ${timeoutInSeconds} seconds`;
            countdownDiv.style.marginBottom = '10px';
            dialog.appendChild(countdownDiv);
        }

        okButton.textContent = 'OK';
        Object.assign(okButton.style, confirmButtonStyle);

        buttonContainer.appendChild(okButton);

        dialog.appendChild(messageDiv);
        dialog.appendChild(buttonContainer);
        document.body.appendChild(dialog);

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
            dialog.remove(); // Remove the dialog from the DOM
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
        const dialog = document.createElement('div');
        const messageDiv = document.createElement('div');
        const inputField = document.createElement('textarea');
        const buttonContainer = document.createElement('div');
        const okButton = document.createElement('button');
        const cancelButton = document.createElement('button');

        // Set up styles
        Object.assign(dialog.style, dialogStyle);

        messageDiv.textContent = message;
        messageDiv.style.marginBottom = '10px';
        messageDiv.style.whiteSpace = 'pre-wrap';

        inputField.type = 'text';
        inputField.value = defaultValue;
        inputField.style.width = '100%';
        inputField.style.padding = '10px';
        inputField.style.border = '1px solid #ccc';
        inputField.style.borderRadius = '5px';
        inputField.style.marginBottom = '10px';
        inputField.style.fontSize = '16px';

        okButton.textContent = 'OK';
        Object.assign(okButton.style, confirmButtonStyle);
        cancelButton.textContent = 'Cancel';
        Object.assign(cancelButton.style, cancelButtonStyle);

        buttonContainer.appendChild(okButton);
        buttonContainer.appendChild(cancelButton);

        dialog.appendChild(messageDiv);
        dialog.appendChild(inputField);
        dialog.appendChild(buttonContainer);
        document.body.appendChild(dialog);

        inputField.focus();

        const cleanup = () => {
            okButton.removeEventListener('click', onOk);
            cancelButton.removeEventListener('click', onCancel);
            inputField.removeEventListener('keydown', onEnter);
            dialog.remove();
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
                onOk();
            }
        };

        okButton.addEventListener('click', onOk);
        cancelButton.addEventListener('click', onCancel);
        inputField.addEventListener('keydown', onEnter);
    });
};

