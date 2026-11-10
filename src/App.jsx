import React, { useMemo, useState } from "react";
import readXlsxFile from "read-excel-file/browser";
import { DEFAULT_HYPERPARAMETERS, fillMissingMatrix } from "./recommendations.js";
import { downloadFilledWorkbook } from "./workbookExport.js";

const PARAMETER_CONTROLS = {
  HybridSVD: [
    { name: "rank", label: "Fatores latentes", min: 1, max: 64, step: 1 },
    { name: "epochs", label: "Épocas", min: 10, max: 1000, step: 10 },
    {
      name: "learningRate",
      label: "Taxa de aprendizado",
      min: 0.0001,
      max: 0.05,
      step: "any",
    },
    {
      name: "regularization",
      label: "Regularização",
      min: 0.0001,
      max: 1,
      step: "any",
    },
  ],
  "KronRLS-MKL": [
    {
      name: "regularization",
      label: "Regularização",
      min: 0.0001,
      max: 10,
      step: "any",
    },
    {
      name: "validationFraction",
      label: "Validação (%)",
      min: 10,
      max: 40,
      step: 1,
      scale: 0.01,
      displayScale: 100,
    },
    {
      name: "kernelSensitivity",
      label: "Sensibilidade dos kernels",
      min: 0.01,
      max: 2,
      step: "any",
    },
  ],
};

function App() {
  const [sheets, setSheets] = useState([]);
  const [values, setValues] = useState([]);
  const [matrixSource, setMatrixSource] = useState(null);
  const [originalMatrix, setOriginalMatrix] = useState(null);
  const [sourceFile, setSourceFile] = useState(null);
  const [method, setMethod] = useState("HybridSVD");
  const [completedMethod, setCompletedMethod] = useState("");
  const [hyperparameters, setHyperparameters] = useState(() => ({
    HybridSVD: { ...DEFAULT_HYPERPARAMETERS.HybridSVD },
    "KronRLS-MKL": { ...DEFAULT_HYPERPARAMETERS["KronRLS-MKL"] },
  }));
  const [completedParameters, setCompletedParameters] = useState(null);
  const [predictions, setPredictions] = useState([]);
  const [cellEdits, setCellEdits] = useState([]);
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [filledCount, setFilledCount] = useState(0);
  const [sheetName, setSheetName] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const matrixSheet = sheets.find((sheet) => sheet.sheet === "Matriz");

  const table = useMemo(() => {
    if (!values.length || !sheetName) {
      return { headers: [], rows: [] };
    }

    const columnCount = values.reduce((max, row) => Math.max(max, row.length), 0);
    const firstRow = values[0] ?? [];
    const headers = Array.from({ length: columnCount }, (_, index) => {
      const value = firstRow[index];
      return value === "" || value == null ? `Coluna ${index + 1}` : String(value);
    });
    const rows = values.slice(1).map((row) =>
      Array.from({ length: columnCount }, (_, index) => row[index] ?? ""),
    );

    return { headers, rows };
  }, [values, sheetName]);

  async function handleFileChange(event) {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";

    if (!selectedFile) {
      return;
    }

    setError("");
    setIsLoading(true);
    setSheets([]);
    setValues([]);
    setMatrixSource(null);
    setOriginalMatrix(null);
    setSourceFile(null);
    setPredictions([]);
    setCellEdits([]);
    setEditingCell(null);
    setFilledCount(0);
    setCompletedMethod("");
    setCompletedParameters(null);
    setSheetName("");
    setFileName("");

    try {
      const parsedSheets = await readXlsxFile(selectedFile);
      if (parsedSheets.length === 0) {
        throw new Error("Este arquivo não contém nenhuma aba para exibir.");
      }

      setSheets(parsedSheets);
      const loadedMatrix = parsedSheets.find((sheet) => sheet.sheet === "Matriz") ?? null;
      setMatrixSource(loadedMatrix);
      setOriginalMatrix(loadedMatrix ? cloneSheet(loadedMatrix) : null);
      setSourceFile(selectedFile);
      setSheetName(parsedSheets[0].sheet);
      setValues(normalizeRows(parsedSheets[0].data));
      setFileName(selectedFile.name);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Não foi possível ler o arquivo. Verifique se ele é um Excel válido.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  function handleSheetChange(event) {
    const selectedSheet = event.target.value;
    const selected = sheets.find((sheet) => sheet.sheet === selectedSheet);
    setSheetName(selectedSheet);
    setValues(normalizeRows(selected?.data ?? []));
  }

  function startEditing(row, column, value) {
    setEditingCell({ sheet: sheetName, row, column });
    setEditValue(value == null ? "" : String(value));
  }

  function cancelEditing() {
    setEditingCell(null);
    setEditValue("");
  }

  function saveEdit() {
    if (!editingCell) {
      return;
    }

    const value = parseEditedValue(editValue);
    const { sheet: editedSheet, row, column } = editingCell;
    const updatedSheets = sheets.map((sheet) => {
      if (sheet.sheet !== editedSheet) {
        return sheet;
      }
      const data = sheet.data.map((currentRow) => currentRow.slice());
      while (data.length <= row) {
        data.push([]);
      }
      data[row][column] = value;
      return { ...sheet, data };
    });

    setSheets(updatedSheets);
    if (editedSheet === sheetName) {
      setValues(normalizeRows(updatedSheets.find((sheet) => sheet.sheet === editedSheet).data));
    }
    if (editedSheet === "Matriz") {
      setMatrixSource(updatedSheets.find((sheet) => sheet.sheet === editedSheet));
    }
    setCellEdits((currentEdits) => [
      ...currentEdits.filter(
        (edit) => edit.sheet !== editedSheet || edit.row !== row || edit.column !== column,
      ),
      { sheet: editedSheet, row, column, value },
    ]);
    setPredictions((currentPredictions) =>
      currentPredictions.filter(
        (prediction) =>
          editedSheet !== "Matriz" || prediction.row !== row || prediction.column !== column,
      ),
    );
    setEditingCell(null);
    setEditValue("");
    setError("");
  }

  function handleResetMatrix() {
    if (!originalMatrix) {
      return;
    }

    const restoredMatrix = cloneSheet(originalMatrix);
    const restoredSheets = sheets.map((sheet) =>
      sheet.sheet === "Matriz" ? restoredMatrix : sheet,
    );
    setSheets(restoredSheets);
    setMatrixSource(restoredMatrix);
    setCellEdits((currentEdits) =>
      currentEdits.filter((edit) => edit.sheet !== "Matriz"),
    );
    setPredictions([]);
    setFilledCount(0);
    setCompletedMethod("");
    setCompletedParameters(null);
    setEditingCell(null);
    setEditValue("");
    setError("");

    if (sheetName === "Matriz") {
      setValues(normalizeRows(restoredMatrix.data));
    }
  }

  async function handleFill() {
    if (!matrixSource) {
      setError('O arquivo não contém uma aba chamada "Matriz".');
      return;
    }

    setError("");
    setIsLoading(true);

    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const currentParameters = { ...hyperparameters[method] };
      const newPredictions = fillMissingMatrix(
        matrixSource,
        sheets,
        method,
        currentParameters,
      );
      const updatedData = matrixSource.data.map((row) => row.slice());
      for (const prediction of newPredictions) {
        updatedData[prediction.row][prediction.column] = prediction.value;
      }

      const updatedSheets = sheets.map((sheet) =>
        sheet.sheet === "Matriz" ? { ...sheet, data: updatedData } : sheet,
      );
      setSheets(updatedSheets);
      setCellEdits((currentEdits) =>
        currentEdits.filter(
          (edit) =>
            edit.sheet !== "Matriz" ||
            !newPredictions.some(
              (prediction) => prediction.row === edit.row && prediction.column === edit.column,
            ),
        ),
      );
      setSheetName("Matriz");
      setValues(normalizeRows(updatedData));
      setPredictions(newPredictions);
      setFilledCount(newPredictions.length);
      setCompletedMethod(method);
      setCompletedParameters(currentParameters);
    } catch (fillError) {
      setError(
        fillError instanceof Error
          ? fillError.message
          : "Não foi possível preencher as células da aba Matriz.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDownload() {
    if (!sourceFile || (predictions.length === 0 && cellEdits.length === 0)) {
      return;
    }
    try {
      const predictionEdits = predictions.map((prediction) => ({
        sheet: "Matriz",
        row: prediction.row,
        column: prediction.column,
        value: prediction.value,
      }));
      await downloadFilledWorkbook(sourceFile, [...predictionEdits, ...cellEdits]);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Não foi possível gerar o arquivo Excel preenchido.",
      );
    }
  }

  return (
    <main className="page">
      <section className="workspace" aria-label="Leitor de planilhas">
        <div className="topbar">
          <div className="upload-copy">
            <div className="file-icon" aria-hidden="true">↥</div>
            <div>
              <h2>{fileName || "Leitor de Excel"}</h2>
              <p>{fileName ? "Arquivo carregado localmente" : "Abra uma planilha para começar"}</p>
            </div>
          </div>
          <div className="topbar-actions">
            {matrixSheet && (
              <>
                <label className="method-picker">
                  <span>Método</span>
                  <select
                    value={method}
                    onChange={(event) => setMethod(event.target.value)}
                    disabled={isLoading}
                    aria-label="Selecionar método de recomendação"
                  >
                    <option value="HybridSVD">HybridSVD</option>
                    <option value="KronRLS-MKL">KronRLS-MKL</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="action-button primary-button"
                  onClick={handleFill}
                  disabled={isLoading}
                >
                  {isLoading ? "Preenchendo..." : "Preencher"}
                </button>
                <button
                  type="button"
                  className="action-button secondary-button"
                  onClick={handleResetMatrix}
                  disabled={isLoading}
                >
                  Resetar
                </button>
                {(predictions.length > 0 || cellEdits.length > 0) && (
                  <button
                    type="button"
                    className="action-button secondary-button"
                    onClick={handleDownload}
                    disabled={isLoading}
                  >
                    Baixar Excel
                  </button>
                )}
              </>
            )}
            <label className={`upload-button${isLoading ? " is-loading" : ""}`}>
              {isLoading && !fileName ? "Lendo arquivo..." : "Abrir arquivo"}
              <input
                type="file"
                accept=".xlsx,.xlsm"
                onChange={handleFileChange}
                disabled={isLoading}
                aria-label="Selecionar arquivo Excel"
              />
            </label>
          </div>
        </div>

        {matrixSheet && (
          <fieldset className="tuning-panel">
            <legend>Parâmetros de {method}</legend>
            <div className="tuning-controls">
              {PARAMETER_CONTROLS[method].map((control) => {
                const scale = control.scale ?? 1;
                const displayScale = control.displayScale ?? 1;
                return (
                  <label className="tuning-control" key={control.name}>
                    <span>{control.label}</span>
                    <input
                      type="number"
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={
                        hyperparameters[method][control.name] === ""
                          ? ""
                          : hyperparameters[method][control.name] * displayScale
                      }
                      onChange={(event) => {
                        const nextValue = event.target.value === ""
                          ? ""
                          : Number(event.target.value) * scale;
                        setHyperparameters((current) => ({
                          ...current,
                          [method]: {
                            ...current[method],
                            [control.name]: nextValue,
                          },
                        }));
                      }}
                      disabled={isLoading}
                      aria-label={control.label}
                    />
                  </label>
                );
              })}
              <button
                type="button"
                className="reset-parameters"
                onClick={() =>
                  setHyperparameters((current) => ({
                    ...current,
                    [method]: { ...DEFAULT_HYPERPARAMETERS[method] },
                  }))
                }
                disabled={isLoading}
              >
                Restaurar padrão
              </button>
            </div>
          </fieldset>
        )}

        {error && <p className="error-message" role="alert">{error}</p>}
        {filledCount > 0 && (
          <p className="success-message" role="status">
            {filledCount} células vazias preenchidas em Matriz com {completedMethod}
            {completedMethod !== method ||
            JSON.stringify(completedParameters) !== JSON.stringify(hyperparameters[method])
              ? ". Os parâmetros mudaram; clique em Preencher para recalcular."
              : "."}
          </p>
        )}

        {sheets.length > 0 ? (
          <section className="sheet-panel" aria-label="Conteúdo da planilha">
            <div className="sheet-toolbar">
              <label className="sheet-picker">
                <span>Aba</span>
                <select
                  value={sheetName}
                  onChange={handleSheetChange}
                  aria-label="Selecionar aba da planilha"
                >
                  {sheets.map(({ sheet }) => (
                    <option key={sheet} value={sheet}>{sheet}</option>
                  ))}
                </select>
              </label>
              <p className="row-count">
                {table.rows.length} {table.rows.length === 1 ? "linha" : "linhas"}
              </p>
            </div>

            {table.headers.length > 0 ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {table.headers.map((header, columnIndex) => {
                        const isEditing = editingCell?.sheet === sheetName &&
                          editingCell.row === 0 && editingCell.column === columnIndex;
                        return (
                          <th
                            key={`${header}-${columnIndex}`}
                            scope="col"
                            className="editable-cell"
                            onDoubleClick={() => startEditing(0, columnIndex, header)}
                            title="Duplo clique para editar"
                          >
                            {isEditing ? (
                              <input
                                className="cell-editor"
                                value={editValue}
                                onChange={(event) => setEditValue(event.target.value)}
                                onBlur={saveEdit}
                                onKeyDown={(event) => handleEditKeyDown(event, saveEdit, cancelEditing)}
                                aria-label={`Editar ${header || `coluna ${columnIndex + 1}`}`}
                                autoFocus
                              />
                            ) : header}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((value, columnIndex) => {
                          const sourceRow = rowIndex + 1;
                          const isEditing = editingCell?.sheet === sheetName &&
                            editingCell.row === sourceRow &&
                            editingCell.column === columnIndex;
                          return (
                            <td
                              key={columnIndex}
                              className="editable-cell"
                              onDoubleClick={() => startEditing(sourceRow, columnIndex, value)}
                              title="Duplo clique para editar"
                            >
                              {isEditing ? (
                                <input
                                  className="cell-editor"
                                  value={editValue}
                                  onChange={(event) => setEditValue(event.target.value)}
                                  onBlur={saveEdit}
                                  onKeyDown={(event) =>
                                    handleEditKeyDown(event, saveEdit, cancelEditing)
                                  }
                                  aria-label={`Editar linha ${sourceRow + 1}, coluna ${columnIndex + 1}`}
                                  autoFocus
                                />
                              ) : value}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty-sheet">Esta aba não contém dados para exibir.</p>
            )}
          </section>
        ) : (
          <div className="empty-state">
            <div className="empty-illustration" aria-hidden="true">
              <div className="sheet-lines"><i /><i /><i /><i /></div>
              <span>+</span>
            </div>
            <h2>Abra uma planilha Excel</h2>
            <p>O conteúdo será exibido aqui, em tela cheia.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function parseEditedValue(value) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return "";
  }
  const numericValue = Number(trimmedValue);
  return Number.isFinite(numericValue) ? numericValue : value;
}

function cloneSheet(sheet) {
  return {
    ...sheet,
    data: sheet.data.map((row) => row.slice()),
  };
}

function handleEditKeyDown(event, save, cancel) {
  if (event.key === "Enter") {
    event.preventDefault();
    save();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  }
}

function normalizeRows(rows) {
  return rows.map((row) =>
    row.map((value) =>
      value instanceof Date ? value.toLocaleDateString() : value == null ? "" : String(value),
    ),
  );
}

export default App;
