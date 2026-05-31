#!/usr/bin/env python3
"""
Audio feature extraction script.
Usage: analyse.py <filepath> [models_dir]

Outputs a single JSON object to stdout with:
  bpm           - beats per minute (float | null)   — via essentia RhythmExtractor2013
  musical_key   - e.g. "C", "F#" (string | null)   — via essentia KeyExtractor
  key_scale     - "major" | "minor" (string | null) — via essentia KeyExtractor
  energy        - 0.0-1.0 normalized (float | null) — via essentia RMS
  danceability  - 0.0-1.0 normalized (float | null) — via essentia Danceability
  mood_tags     - [{"tag": str, "score": float}, ...] sorted by score desc — via essentia-tensorflow (optional)
  warnings      - [str, ...] non-fatal errors from individual steps
"""
import sys
import json
import os


MOODS = ['happy', 'sad', 'aggressive', 'relaxed', 'party', 'acoustic', 'electronic']


def analyse_bpm(filepath):
    import essentia.standard as es
    audio = es.MonoLoader(filename=filepath, sampleRate=44100)()
    bpm, _, _, _, _ = es.RhythmExtractor2013(method='multifeature')(audio)
    return round(float(bpm), 1)


def analyse_essentia_basic(filepath):
    import essentia.standard as es
    audio = es.MonoLoader(filename=filepath, sampleRate=44100)()
    key, scale, _ = es.KeyExtractor()(audio)
    danceability, _ = es.Danceability()(audio)
    rms = float(es.RMS()(audio))
    # Normalize: typical music RMS is 0.01-0.3; cap at 1.0
    energy = round(min(1.0, rms / 0.3), 3)
    # Danceability: Essentia returns 0-3 range; normalize to 0-1
    danceability_norm = round(min(1.0, float(danceability) / 3.0), 3)
    return {
        'musical_key': key if key else None,
        'key_scale': scale if scale else None,
        'energy': energy,
        'danceability': danceability_norm,
    }


def analyse_mood(filepath, models_dir):
    # TF-based mood classification requires essentia-tensorflow.
    # If it's not installed, return empty list silently.
    try:
        import essentia.standard as es
        # Probe for a TF algorithm — raises AttributeError if TF support absent.
        _ = es.TensorflowPredictMusiCNN
    except AttributeError:
        return [], 'essentia-tensorflow not installed — run analysis/setup.sh for mood support'

    import numpy as np

    embedding_path = os.path.join(models_dir, 'msd-musicnn-1.pb')
    if not os.path.exists(embedding_path):
        return [], f'embedding model not found — run analysis/download_models.sh'

    audio = es.MonoLoader(filename=filepath, sampleRate=16000)()

    embedding_model = es.TensorflowPredictMusiCNN(
        graphFilename=embedding_path,
        output='model/dense/BiasAdd',
    )
    embeddings = embedding_model(audio)

    tags = []
    for mood in MOODS:
        model_path = os.path.join(models_dir, f'mood_{mood}-msd-musicnn-1.pb')
        if not os.path.exists(model_path):
            continue
        classifier = es.TensorflowPredict2D(
            graphFilename=model_path,
            output='model/Softmax',
        )
        preds = classifier(embeddings)
        # preds: (n_patches, 2) — column 1 is probability of this mood
        score = round(float(np.array(preds)[:, 1].mean()), 3)
        tags.append({'tag': mood, 'score': score})

    tags.sort(key=lambda x: -x['score'])
    return tags, None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: analyse.py <filepath> [models_dir]'}))
        sys.exit(1)

    filepath = sys.argv[1]
    models_dir = (
        sys.argv[2]
        if len(sys.argv) > 2
        else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models')
    )

    result = {}
    warnings = []

    try:
        result['bpm'] = analyse_bpm(filepath)
    except Exception as e:
        warnings.append(f'bpm: {e}')
        result['bpm'] = None

    try:
        basic = analyse_essentia_basic(filepath)
        result.update(basic)
    except Exception as e:
        warnings.append(f'essentia_basic: {e}')
        result.setdefault('musical_key', None)
        result.setdefault('key_scale', None)
        result.setdefault('energy', None)
        result.setdefault('danceability', None)

    try:
        tags, warning = analyse_mood(filepath, models_dir)
        result['mood_tags'] = tags
        if warning:
            warnings.append(f'mood: {warning}')
    except Exception as e:
        warnings.append(f'mood: {e}')
        result['mood_tags'] = []

    if warnings:
        result['warnings'] = warnings

    print(json.dumps(result))


if __name__ == '__main__':
    main()
