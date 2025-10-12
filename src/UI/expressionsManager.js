// This is a simple widget that contains a text area.
// The text area is going to have javascript code



export class expressionsManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.uiElement = document.createElement('div');
        this.expressionCode = '';
        this.generateUI();
    }

    generateUI() {
        // add a style element with the styles
        const style = document.createElement('style');
        style.textContent = `
            .test-expressions-button {
                background: rgb(31, 41, 55);
                color: rgb(249, 250, 251);
                border: 1px solid rgb(55, 65, 81);
                padding: 3px;
                border-radius: 8px;
                cursor: pointer;
                font-weight: 700;
                outline: none;
                transition: background 120ms, transform 60ms, box-shadow 120ms;
                user-select: none;
                box-shadow: none;
                transform: none;
            }
            .test-expressions-button:hover {
                background-color: #45a049;
            }
            .expressions-textarea {
                width: 100%;
                height: 200px;
                font-family: monospace;
                padding: 5px;
            }
            .expressions-results {
                margin-top: 10px;
                font-weight: bold;
                padding: 5px;
                color: red;
            }
        `;
        document.head.appendChild(style);

        const textArea = document.createElement('textarea');
        textArea.placeholder = `// example Javascript math syntax . . .\nx = 30;\ny = 2 * x;`;
        this.uiElement.appendChild(textArea);
        this.textArea = textArea;
        this.textArea.classList.add('expressions-textarea');
        textArea.value = this.viewer.partHistory.expressions;
        this.textArea.addEventListener('change', () => this.saveAndTest());
        this.uiElement.appendChild(this.textArea);

        // add a button that can trigger the save and test method
        this.saveButton = document.createElement('button');
        this.saveButton.textContent = 'Test Expressions';
        this.saveButton.classList.add('test-expressions-button');
        this.saveButton.addEventListener('click', () => this.saveAndTest());
        this.uiElement.appendChild(this.saveButton);


        this.resultDiv = document.createElement('div');
        this.resultDiv.classList.add('expressions-results');
        this.uiElement.appendChild(this.resultDiv);
    }

    saveAndTest() {
        this.resultDiv.textContent = "Expressions evaluated successfully.";
        this.resultDiv.style.color = 'green';
        let succeeded = false;
        try {
            const functionString = `return (function(){ ${this.textArea.value} ;});`;
            let result = Function(functionString)();
            this.viewer.partHistory.expressions = this.textArea.value;
            succeeded = true;
        } catch (error) {
            this.resultDiv.innerHTML = "Error occurred while testing expressions. <br>" + error.message;
            this.resultDiv.style.color = 'red';
            succeeded = false;
        }

        if (succeeded) {
            this.resultDiv.textContent = "Expressions evaluated successfully.";
            this.resultDiv.style.color = 'green';
            this.viewer.partHistory.runHistory();
        }
    }
}
