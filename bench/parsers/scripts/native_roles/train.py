"""Leave-book-out grouped CV on the training books, then one model on all of them.

usage: train.py
Reads OUT/labels.pkl and OUT/pages/*.pkl. Writes OUT/features.pkl (X per page),
OUT/cv.json (per-class scores, confusion, CV predictions) and OUT/model.txt.
"""

import json
import pickle
from collections import defaultdict

import lightgbm as lgb
import numpy as np

from common import OUT, ROLES
from features import NAMES, featurize

FOLDS = 8
PARAMS = dict(objective="multiclass", num_class=len(ROLES), learning_rate=0.05, num_leaves=31,
              min_child_samples=20, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1,
              lambda_l2=1.0, verbose=-1, num_threads=4, seed=7)
ROUNDS = 200  # 400 gave the same held-out F1 at twice the single-thread inference cost
BOOK_LINES = 4000


def page_features(recs):
    path = OUT / "features.pkl"
    if path.exists():
        return pickle.load(path.open("rb"))
    feats, books = {}, {}
    for r in recs:
        if r["book"] not in books:
            books[r["book"]] = pickle.load((OUT / "pages" / f"{r['book']}.pkl").open("rb"))
        B = books[r["book"]]
        feats[(r["book"], r["page"])] = featurize(B["pages"][r["page"]], B["stats"], B["page_count"])
    pickle.dump(feats, path.open("wb"))
    return feats


def matrix(recs, feats, labelled=True):
    X, y, book, idx = [], [], [], []
    for k, r in enumerate(recs):
        F = feats[(r["book"], r["page"])]
        for i, role in enumerate(r["roles"]):
            if labelled and role is None:
                continue
            X.append(F[i])
            y.append(ROLES.index(role) if role else -1)
            book.append(r["book"])
            idx.append((k, i))
    return np.array(X, np.float32).reshape(-1, len(NAMES)), np.array(y), np.array(book), idx


def weights(y, book):
    """sqrt-balanced class weights (rare roles count more, not by the full ratio), and
    a book with more than BOOK_LINES labelled lines (scatter plots set as glyphs) is scaled down."""
    n = np.bincount(y, minlength=len(ROLES)).astype(float)
    w = np.sqrt(n.max() / np.maximum(n, 1))[y]
    names, counts = np.unique(book, return_counts=True)
    per = dict(zip(names, np.minimum(1.0, BOOK_LINES / counts)))
    return w * np.array([per[b] for b in book])


def fit(X, y, book):
    return lgb.train(PARAMS, lgb.Dataset(X, y, weight=weights(y, book), feature_name=NAMES), ROUNDS)


def scores(gold, pred):
    out = {}
    for c, name in enumerate(ROLES):
        tp = int(((gold == c) & (pred == c)).sum())
        fp = int(((gold != c) & (pred == c)).sum())
        fn = int(((gold == c) & (pred != c)).sum())
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        out[name] = dict(n=tp + fn, pred=tp + fp, p=round(p, 3), r=round(r, 3), f1=round(2 * p * r / (p + r), 3) if p + r else 0.0)
    return out


def confusion(gold, pred):
    m = np.zeros((len(ROLES), len(ROLES)), int)
    np.add.at(m, (gold, pred), 1)
    return m.tolist()


if __name__ == "__main__":
    recs = pickle.load((OUT / "labels.pkl").open("rb"))
    feats = page_features(recs)
    train = [r for r in recs if r["split"] == "train"]
    X, y, book, idx = matrix(train, feats)
    books = sorted(set(book))
    rng = np.random.default_rng(13)
    order = rng.permutation(books)
    fold_of = {b: i % FOLDS for i, b in enumerate(order)}
    folds = np.array([fold_of[b] for b in book])
    pred = np.zeros(len(y), int)
    proba = np.zeros((len(y), len(ROLES)), np.float32)
    for f in range(FOLDS):
        m = fit(X[folds != f], y[folds != f], book[folds != f])
        proba[folds == f] = m.predict(X[folds == f])
        pred[folds == f] = proba[folds == f].argmax(1)
        print("fold", f, flush=True)
    per_book = defaultdict(dict)
    for b in books:
        s = book == b
        per_book[b] = {k: v for k, v in scores(y[s], pred[s]).items() if v["n"] or v["pred"]}
    model = fit(X, y, book)
    model.save_model(str(OUT / "model.txt"))
    imp = sorted(zip(NAMES, model.feature_importance("gain")), key=lambda t: -t[1])
    cv = dict(lines=len(y), books=len(books), folds=FOLDS, scores=scores(y, pred), confusion=confusion(y, pred),
              per_book=per_book, importance=[(n, round(float(g))) for n, g in imp[:25]])
    (OUT / "cv.json").write_text(json.dumps(cv, indent=1))
    pickle.dump(dict(idx=idx, pred=pred, proba=proba), (OUT / "cv_pred.pkl").open("wb"))
    for k, v in cv["scores"].items():
        print(f"{k:12s} n={v['n']:6d} P={v['p']:.2f} R={v['r']:.2f} F1={v['f1']:.2f}")
