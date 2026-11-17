"use strict";

// Complaint router scoring, shared by the site and Node. The model object is the one written to
// site/data/model.json: products, terms, idf, coef, intercept and threshold.
function termIndex(model) {
  if (model.__termIndex instanceof Map) {
    return model.__termIndex;
  }
  const index = new Map();
  for (let j = 0; j < model.terms.length; j++) {
    index.set(model.terms[j], j);
  }
  try {
    Object.defineProperty(model, "__termIndex", {
      value: index,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch (error) {
    model.__termIndex = index;
  }
  return index;
}

function classify(text, model) {
  const index = termIndex(model);
  const source = text == null ? "" : String(text);
  const tokens = source.toLowerCase().match(/[a-z0-9]{2,}/g) || [];

  // Count one-word terms and adjacent two-word terms that are in the vocabulary.
  const counts = new Map();
  const bump = (term) => {
    if (!index.has(term)) {
      return;
    }
    counts.set(term, (counts.get(term) || 0) + 1);
  };
  for (let i = 0; i < tokens.length; i++) {
    bump(tokens[i]);
    if (i + 1 < tokens.length) {
      bump(tokens[i] + " " + tokens[i + 1]);
    }
  }

  const x = new Float64Array(model.terms.length);
  let squared = 0;
  for (const [term, count] of counts) {
    const j = index.get(term);
    const value = (1 + Math.log(count)) * model.idf[j];
    x[j] = value;
    squared += value * value;
  }
  const norm = Math.sqrt(squared);
  if (norm > 0) {
    for (let j = 0; j < x.length; j++) {
      x[j] /= norm;
    }
  }

  const scores = new Float64Array(model.products.length);
  for (let k = 0; k < scores.length; k++) {
    let score = model.intercept[k];
    const row = model.coef[k];
    for (const term of counts.keys()) {
      const j = index.get(term);
      score += row[j] * x[j];
    }
    scores[k] = score;
  }

  let winner = 0;
  let top = scores[0];
  for (let k = 1; k < scores.length; k++) {
    if (scores[k] > top) {
      top = scores[k];
      winner = k;
    }
  }

  let total = 0;
  const weights = new Float64Array(scores.length);
  for (let k = 0; k < scores.length; k++) {
    weights[k] = Math.exp(scores[k] - top);
    total += weights[k];
  }
  const probabilities = model.products.map((product, k) => ({
    product,
    p: weights[k] / total,
  }));
  probabilities.sort((a, b) => b.p - a.p);
  const confidence = probabilities[0].p;

  // The text terms that push the winning product up the most.
  const contributions = [];
  const row = model.coef[winner];
  for (const term of counts.keys()) {
    const j = index.get(term);
    const weight = row[j] * x[j];
    if (weight > 0) {
      contributions.push({ term, weight });
    }
  }
  contributions.sort((a, b) => b.weight - a.weight);

  const routed = model.threshold != null && confidence >= model.threshold;
  return {
    product: model.products[winner],
    confidence,
    probabilities,
    routed,
    terms: contributions.slice(0, 8),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { classify };
}
if (typeof window !== "undefined") {
  window.classify = classify;
}
