import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const OFFICE_RELATIONSHIP_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export async function downloadFilledWorkbook(file, edits) {
  const contents = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const workbookXml = parseXml(contents["xl/workbook.xml"], "estrutura da pasta de trabalho");
  const relationshipsXml = parseXml(
    contents["xl/_rels/workbook.xml.rels"],
    "relacionamentos da pasta de trabalho",
  );

  const sheetElements = Array.from(workbookXml.getElementsByTagNameNS("*", "sheet"));
  const relationships = Array.from(
    relationshipsXml.getElementsByTagNameNS("*", "Relationship"),
  );
  const editedSheets = new Map();
  for (const edit of edits) {
    let worksheetXml = editedSheets.get(edit.sheet);
    if (!worksheetXml) {
      const sheetElement = sheetElements.find(
        (sheet) => sheet.getAttribute("name") === edit.sheet,
      );
      if (!sheetElement) {
        throw new Error(`A aba "${edit.sheet}" não foi encontrada no arquivo original.`);
      }

      const relationshipId =
        sheetElement.getAttributeNS(OFFICE_RELATIONSHIP_NS, "id") ||
        sheetElement.getAttribute("r:id");
      const relationship = relationships.find((item) => item.getAttribute("Id") === relationshipId);
      if (!relationship) {
        throw new Error(`Não foi possível localizar o arquivo interno da aba "${edit.sheet}".`);
      }

      const worksheetPath = resolveZipPath("xl", relationship.getAttribute("Target"));
      worksheetXml = parseXml(
        contents[worksheetPath],
        `conteúdo da aba "${edit.sheet}"`,
      );
      const sheetData = worksheetXml.getElementsByTagNameNS("*", "sheetData")[0];
      if (!sheetData) {
        throw new Error(`A aba "${edit.sheet}" não contém dados que possam ser atualizados.`);
      }
      editedSheets.set(edit.sheet, { worksheetXml, worksheetPath, sheetData });
    } else {
      worksheetXml = editedSheets.get(edit.sheet).worksheetXml;
    }

    const sheetState = editedSheets.get(edit.sheet);
    writeCell(sheetState.worksheetXml, sheetState.sheetData, edit);
  }

  for (const { worksheetXml, worksheetPath } of editedSheets.values()) {
    contents[worksheetPath] = strToU8(new XMLSerializer().serializeToString(worksheetXml));
  }

  const output = zipSync(contents, { level: 6 });
  const extension = file.name.match(/\.(xlsx|xlsm)$/i)?.[0] ?? ".xlsx";
  const baseName = file.name.replace(/\.(xlsx|xlsm)$/i, "");
  const mimeType = extension.toLowerCase() === ".xlsm"
    ? "application/vnd.ms-excel.sheet.macroEnabled.12"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const url = URL.createObjectURL(new Blob([output], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${baseName}-preenchido${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function writeCell(worksheetXml, sheetData, edit) {
  const excelRow = edit.row + 1;
  const excelColumn = edit.column + 1;
  const reference = `${columnName(excelColumn)}${excelRow}`;
  const rows = Array.from(sheetData.getElementsByTagNameNS("*", "row"));
  let row = rows.find((candidate) => Number(candidate.getAttribute("r")) === excelRow);
  if (!row) {
    row = worksheetXml.createElementNS(sheetData.namespaceURI, "row");
    row.setAttribute("r", String(excelRow));
    insertSortedRow(sheetData, row);
  }

  let cell = Array.from(row.getElementsByTagNameNS("*", "c"))
    .find((item) => item.getAttribute("r") === reference);
  if (!cell) {
    cell = worksheetXml.createElementNS(sheetData.namespaceURI, "c");
    cell.setAttribute("r", reference);
    insertSortedCell(row, cell);
  }

  while (cell.firstChild) {
    cell.removeChild(cell.firstChild);
  }
  cell.removeAttribute("t");
  if (edit.value === null || edit.value === undefined || edit.value === "") {
    return;
  }

  if (typeof edit.value === "number" && Number.isFinite(edit.value)) {
    cell.setAttribute("t", "n");
    const value = worksheetXml.createElementNS(sheetData.namespaceURI, "v");
    value.textContent = String(edit.value);
    cell.appendChild(value);
    return;
  }
  if (typeof edit.value === "boolean") {
    cell.setAttribute("t", "b");
    const value = worksheetXml.createElementNS(sheetData.namespaceURI, "v");
    value.textContent = edit.value ? "1" : "0";
    cell.appendChild(value);
    return;
  }

  cell.setAttribute("t", "inlineStr");
  const inlineString = worksheetXml.createElementNS(sheetData.namespaceURI, "is");
  const text = worksheetXml.createElementNS(sheetData.namespaceURI, "t");
  text.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
  text.textContent = String(edit.value);
  inlineString.appendChild(text);
  cell.appendChild(inlineString);
}

function parseXml(bytes, description) {
  if (!bytes) {
    throw new Error(`Não foi possível encontrar a ${description} no arquivo Excel.`);
  }
  const xml = new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
  if (xml.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`Não foi possível interpretar a ${description} do arquivo Excel.`);
  }
  return xml;
}

function resolveZipPath(basePath, target) {
  const parts = target.startsWith("/") ? [] : basePath.split("/");
  for (const part of target.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function insertSortedRow(sheetData, row) {
  const rowNumber = Number(row.getAttribute("r"));
  const nextRow = Array.from(sheetData.getElementsByTagNameNS("*", "row"))
    .find((candidate) => Number(candidate.getAttribute("r")) > rowNumber);
  sheetData.insertBefore(row, nextRow ?? null);
}

function insertSortedCell(row, cell) {
  const column = cellColumn(cell.getAttribute("r"));
  const nextCell = Array.from(row.getElementsByTagNameNS("*", "c"))
    .find((candidate) => cellColumn(candidate.getAttribute("r")) > column);
  row.insertBefore(cell, nextCell ?? null);
}

function columnName(column) {
  let value = column;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function cellColumn(reference) {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  return [...letters].reduce((column, letter) =>
    column * 26 + letter.charCodeAt(0) - 64, 0,
  );
}
