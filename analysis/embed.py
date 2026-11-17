"""Sentence embeddings, cached on disk so later steps are repeatable."""
import hashlib

import numpy as np

import config

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MAX_CHARS = 2000


def embed(texts: list[str], cache_name: str, ids) -> np.ndarray:
    """Unit-length embeddings of the first MAX_CHARS characters of each text.

    The cache file is keyed by the ids it was built for; a different set of ids rebuilds it.
    """
    key = hashlib.md5(",".join(map(str, ids)).encode()).hexdigest()[:12]
    path = config.MODELS_DIR / f"emb_{cache_name}_{key}.npy"
    if path.exists():
        return np.load(path)
    import torch
    from sentence_transformers import SentenceTransformer

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = SentenceTransformer(MODEL_NAME, device=device)
    model.max_seq_length = 256
    out = model.encode([t[:MAX_CHARS] for t in texts], batch_size=256, normalize_embeddings=True,
                       show_progress_bar=False, convert_to_numpy=True).astype(np.float32)
    config.MODELS_DIR.mkdir(parents=True, exist_ok=True)
    np.save(path, out)
    return out
