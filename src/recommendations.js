const RATING_MIN = 1;
const RATING_MAX = 5;

export const DEFAULT_HYPERPARAMETERS = {
  HybridSVD: {
    rank: 12,
    epochs: 220,
    learningRate: 0.006,
    regularization: 0.04,
  },
  "KronRLS-MKL": {
    regularization: 0.25,
    validationFraction: 0.2,
    kernelSensitivity: 0.2,
  },
};

export function fillMissingMatrix(matrix, sheets, method, parameters = {}) {
  const rows = matrix.data;
  if (!Array.isArray(rows) || rows.length < 2 || rows[0].length < 2) {
    throw new Error("A aba Matriz não contém uma tabela de compatibilidade válida.");
  }

  const rowCount = rows.length - 1;
  const columnCount = Math.max(0, ...rows.map((row) => row.length)) - 1;
  const observations = [];

  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const score = toRating(rows[row]?.[column]);
      if (score !== null) {
        observations.push({ row: row - 1, column: column - 1, score });
      }
    }
  }

  if (observations.length < 2) {
    throw new Error("A Matriz precisa ter pelo menos duas notas numéricas conhecidas.");
  }

  let predictor;
  if (method === "HybridSVD") {
    predictor = trainHybridSvd(
      rowCount,
      columnCount,
      observations,
      validateParameters(method, parameters),
    );
  } else if (method === "KronRLS-MKL") {
    const scions = sheets.find((sheet) => sheet.sheet === "Copas");
    const rootstocks = sheets.find((sheet) => sheet.sheet === "Porta-enxertos");
    if (!scions || !rootstocks) {
      throw new Error(
        "O método KronRLS-MKL precisa das abas Copas e Porta-enxertos no mesmo arquivo.",
      );
    }
    predictor = trainKronRlsMkl(
      rows,
      scions.data,
      rootstocks.data,
      observations,
      validateParameters(method, parameters),
    );
  } else {
    throw new Error("Selecione um método de preenchimento válido.");
  }

  function validateParameters(method, parameters) {
    const defaults = DEFAULT_HYPERPARAMETERS[method];
    const values = { ...defaults, ...parameters };
    const limits = method === "HybridSVD"
      ? {
          rank: [1, 64, true],
          epochs: [10, 1000, true],
          learningRate: [0.0001, 0.05, false],
          regularization: [0.0001, 1, false],
        }
      : {
          regularization: [0.0001, 10, false],
          validationFraction: [0.1, 0.4, false],
          kernelSensitivity: [0.01, 2, false],
        };

    for (const [name, [minimum, maximum, integer]] of Object.entries(limits)) {
      const value = values[name];
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < minimum ||
        value > maximum ||
        (integer && !Number.isInteger(value))
      ) {
        throw new Error(
          `Parâmetro ${name} inválido para ${method}. Use um valor entre ${minimum} e ${maximum}${integer ? " (inteiro)" : ""}.`,
        );
      }
    }
    return values;
  }

  const predictions = [];
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      const currentValue = rows[row]?.[column];
      if (currentValue !== null && currentValue !== undefined && currentValue !== "") {
        continue;
      }

      const score = predictor(row - 1, column - 1);
      predictions.push({
        row: row,
        column,
        value: Math.round(clamp(score, RATING_MIN, RATING_MAX)),
      });
    }
  }

  if (predictions.length === 0) {
    throw new Error("A aba Matriz não possui células vazias para preencher.");
  }
  return predictions;
}

function toRating(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clamp(value, RATING_MIN, RATING_MAX);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return clamp(parsed, RATING_MIN, RATING_MAX);
    }
  }
  return null;
}

function trainHybridSvd(rowCount, columnCount, observations, parameters) {
  const { rank, epochs, learningRate, regularization } = parameters;
  const mean = observations.reduce((sum, item) => sum + item.score, 0) / observations.length;
  const rowBias = new Float64Array(rowCount);
  const columnBias = new Float64Array(columnCount);
  const rowFactors = makeFactors(rowCount, rank, 31);
  const columnFactors = makeFactors(columnCount, rank, 97);
  let seed = 431;
  const training = observations.slice();

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let index = training.length - 1; index > 0; index -= 1) {
      seed = nextSeed(seed);
      const other = seed % (index + 1);
      [training[index], training[other]] = [training[other], training[index]];
    }

    for (const item of training) {
      let estimate = mean + rowBias[item.row] + columnBias[item.column];
      for (let factor = 0; factor < rank; factor += 1) {
        estimate += rowFactors[item.row][factor] * columnFactors[item.column][factor];
      }
      const error = item.score - estimate;
      rowBias[item.row] += learningRate * (error - regularization * rowBias[item.row]);
      columnBias[item.column] +=
        learningRate * (error - regularization * columnBias[item.column]);

      for (let factor = 0; factor < rank; factor += 1) {
        const rowFactor = rowFactors[item.row][factor];
        const columnFactor = columnFactors[item.column][factor];
        rowFactors[item.row][factor] +=
          learningRate * (error * columnFactor - regularization * rowFactor);
        columnFactors[item.column][factor] +=
          learningRate * (error * rowFactor - regularization * columnFactor);
      }
    }
  }

  return (row, column) => {
    let estimate = mean + rowBias[row] + columnBias[column];
    for (let factor = 0; factor < rank; factor += 1) {
      estimate += rowFactors[row][factor] * columnFactors[column][factor];
    }
    return estimate;
  };
}

function makeFactors(count, rank, seed) {
  return Array.from({ length: count }, () =>
    Array.from({ length: rank }, () => {
      seed = nextSeed(seed);
      return (seed / 0x7fffffff - 0.5) * 0.08;
    }),
  );
}

function trainKronRlsMkl(matrix, scionData, rootstockData, observations, parameters) {
  if (observations.length < 8) {
    throw new Error("O KronRLS-MKL precisa de pelo menos oito notas conhecidas para validar os kernels.");
  }

  const scionNames = matrix.slice(1).map((row) => row[0]);
  const rootstockNames = matrix[0].slice(1);
  const scionKernels = buildEntityKernels(scionNames, scionData);
  const rootstockKernels = buildEntityKernels(rootstockNames, rootstockData);
  const kernelPairs = [];

  scionKernels.forEach((scionKernel, scionIndex) => {
    rootstockKernels.forEach((rootstockKernel, rootstockIndex) => {
      kernelPairs.push({
        scionIndex,
        rootstockIndex,
        scionKernel,
        rootstockKernel,
      });
    });
  });

  const shuffled = observations.slice();
  let seed = 1709;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    seed = nextSeed(seed);
    const other = seed % (index + 1);
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }

  const { regularization, validationFraction, kernelSensitivity } = parameters;
  const validationCount = Math.max(1, Math.floor(shuffled.length * validationFraction));
  const validation = shuffled.slice(0, validationCount);
  const training = shuffled.slice(validationCount);
  const kernelErrors = kernelPairs.map((pair) => {
    const alpha = fitKrr(training, pair, regularization);
    let squaredError = 0;
    for (const item of validation) {
      const estimate = predictKrr(item, training, alpha, pair);
      squaredError += (item.score - estimate) ** 2;
    }
    return Math.sqrt(squaredError / validation.length);
  });

  const bestError = Math.min(...kernelErrors);
  const temperature = Math.max(0.25, bestError * kernelSensitivity);
  const weights = kernelErrors.map((error) => Math.exp(-(error - bestError) / temperature));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const normalizedWeights = weights.map((weight) => weight / weightSum);
  const alpha = fitCombinedKrr(training, kernelPairs, normalizedWeights, regularization);

  return (row, column) => {
    let prediction = 0;
    for (let index = 0; index < kernelPairs.length; index += 1) {
      prediction += normalizedWeights[index] *
        predictKrr({ row, column }, training, alpha, kernelPairs[index]);
    }
    return prediction;
  };
}

function buildEntityKernels(names, data) {
  const headers = data[0] ?? [];
  const records = new Map();
  for (const row of data.slice(1)) {
    if (row[0] !== null && row[0] !== undefined && row[0] !== "") {
      records.set(normalizeKey(row[0]), row);
    }
  }

  const aligned = names.map((name) => records.get(normalizeKey(name)) ?? []);
  const categoricalColumns = [];
  const markerColumns = [];
  const numericColumns = [];

  headers.forEach((header, index) => {
    if (index === 0 || !header) {
      return;
    }
    const isMarker = String(header).toUpperCase().includes("ALELO");
    const hasNumbers = aligned.some((row) => typeof row[index] === "number");
    if (isMarker) {
      markerColumns.push(index);
    } else if (hasNumbers) {
      numericColumns.push(index);
    } else {
      categoricalColumns.push(index);
    }
  });

  return [
    categoricalKernel(aligned, categoricalColumns, headers),
    categoricalKernel(aligned, markerColumns, headers),
    numericKernel(aligned, numericColumns),
  ];
}

function categoricalKernel(rows, columns, headers) {
  const vectors = rows.map((row) => {
    const vector = new Set();
    for (const column of columns) {
      const value = row[column];
      if (value === null || value === undefined || value === "") {
        continue;
      }
      const category = `${column}:${String(headers[column])}:${String(value).trim().toUpperCase()}`;
      vector.add(category);
    }
    return vector;
  });
  const norms = vectors.map((vector) => Math.sqrt(vector.size));
  return vectors.map((left, leftIndex) =>
    vectors.map((right, rightIndex) => {
      if (leftIndex === rightIndex) {
        return 1;
      }
      const denominator = norms[leftIndex] * norms[rightIndex];
      if (denominator === 0) {
        return 0;
      }
      let shared = 0;
      for (const category of left) {
        if (right.has(category)) {
          shared += 1;
        }
      }
      return shared / denominator;
    }),
  );
}

function numericKernel(rows, columns) {
  if (columns.length === 0) {
    return identityKernel(rows.length);
  }
  const means = columns.map((column) => {
    const values = rows.map((row) => row[column]).filter(Number.isFinite);
    return values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  });
  const scales = columns.map((column, index) => {
    const values = rows.map((row) => row[column]).filter(Number.isFinite);
    if (values.length < 2) {
      return 1;
    }
    const variance = values.reduce((sum, value) => sum + (value - means[index]) ** 2, 0) /
      values.length;
    return Math.sqrt(variance) || 1;
  });
  const vectors = rows.map((row) =>
    columns.map((column, index) =>
      Number.isFinite(row[column]) ? (row[column] - means[index]) / scales[index] : 0,
    ),
  );
  const divisor = Math.max(1, columns.length);
  return vectors.map((left, leftIndex) =>
    vectors.map((right, rightIndex) => {
      if (leftIndex === rightIndex) {
        return 1;
      }
      let distance = 0;
      for (let index = 0; index < left.length; index += 1) {
        distance += (left[index] - right[index]) ** 2;
      }
      return Math.exp(-distance / (2 * divisor));
    }),
  );
}

function identityKernel(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

function fitKrr(training, pair, regularization) {
  const kernel = training.map((left) =>
    training.map((right) => pair.scionKernel[left.row][right.row] *
      pair.rootstockKernel[left.column][right.column]),
  );
  for (let index = 0; index < kernel.length; index += 1) {
    kernel[index][index] += regularization;
  }
  return choleskySolve(kernel, training.map((item) => item.score));
}

function fitCombinedKrr(training, kernelPairs, weights, regularization) {
  const kernel = training.map((left, leftIndex) =>
    training.map((right, rightIndex) => {
      let value = 0;
      for (let pairIndex = 0; pairIndex < kernelPairs.length; pairIndex += 1) {
        const pair = kernelPairs[pairIndex];
        value += weights[pairIndex] *
          pair.scionKernel[left.row][right.row] *
          pair.rootstockKernel[left.column][right.column];
      }
      return value;
    }),
  );
  for (let index = 0; index < kernel.length; index += 1) {
    kernel[index][index] += regularization;
  }
  return choleskySolve(kernel, training.map((item) => item.score));
}

function predictKrr(item, training, alpha, pair) {
  let prediction = 0;
  for (let index = 0; index < training.length; index += 1) {
    const observed = training[index];
    prediction += alpha[index] *
      pair.scionKernel[item.row][observed.row] *
      pair.rootstockKernel[item.column][observed.column];
  }
  return prediction;
}

function choleskySolve(matrix, values) {
  const size = matrix.length;
  const lower = Array.from({ length: size }, () => new Float64Array(size));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index += 1) {
        value -= lower[row][index] * lower[column][index];
      }
      if (row === column) {
        lower[row][column] = Math.sqrt(Math.max(value, 1e-10));
      } else {
        lower[row][column] = value / lower[column][column];
      }
    }
  }

  const intermediate = new Float64Array(size);
  for (let row = 0; row < size; row += 1) {
    let value = values[row];
    for (let column = 0; column < row; column += 1) {
      value -= lower[row][column] * intermediate[column];
    }
    intermediate[row] = value / lower[row][row];
  }

  const result = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = intermediate[row];
    for (let column = row + 1; column < size; column += 1) {
      value -= lower[column][row] * result[column];
    }
    result[row] = value / lower[row][row];
  }
  return result;
}

function normalizeKey(value) {
  return String(value)
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function nextSeed(seed) {
  return (Math.imul(seed, 48271) % 0x7fffffff + 0x7fffffff) % 0x7fffffff;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
