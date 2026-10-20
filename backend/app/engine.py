"""Deterministic reconciliation and explainable data-quality checks."""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from difflib import SequenceMatcher
import json
import math
import re
from typing import Any
from numbers import Number

import pandas as pd

try:
    from rapidfuzz import fuzz, process
except ImportError:  # Optional in constrained installations.
    fuzz = None
    process = None

MAX_EXCEPTIONS = 200_000


def is_missing(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    try:
        missing = pd.isna(value)
        return bool(missing) if not hasattr(missing, "__len__") else False
    except (TypeError, ValueError):
        return False


def json_safe(value: Any) -> Any:
    if is_missing(value):
        return None
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return value.isoformat()
    if hasattr(value, "item"):
        try:
            return json_safe(value.item())
        except (ValueError, TypeError):
            pass
    if isinstance(value, (str, int, float, bool)):
        if isinstance(value, float) and not math.isfinite(value):
            return None
        return value
    return str(value)


def display_value(value: Any) -> str:
    safe = json_safe(value)
    return "" if safe is None else str(safe)


def normalize_value(value: Any, trim_whitespace: bool, case_insensitive: bool) -> str | None:
    if is_missing(value):
        return None
    if isinstance(value, (pd.Timestamp, datetime, date)):
        if isinstance(value, (pd.Timestamp, datetime)) and value.time() == datetime.min.time():
            text = value.date().isoformat()
        else:
            text = value.isoformat()
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        text = str(int(value))
    else:
        text = str(value)
    if trim_whitespace:
        text = text.strip()
    if case_insensitive:
        text = text.casefold()
    return text


def _key(row: dict[str, Any], key_pairs: list[dict[str, str]], side: str,
         trim: bool, case_insensitive: bool) -> tuple[str, ...] | None:
    values: list[str] = []
    for pair in key_pairs:
        col = pair[side]
        normalized = normalize_value(row.get(col), trim, case_insensitive)
        if normalized is None:
            return None
        values.append(normalized)
    return tuple(values)


def _key_label(row: dict[str, Any] | None, key_pairs: list[dict[str, str]], side: str) -> str:
    if row is None:
        return ""
    return " | ".join(f"{pair[side]}={display_value(row.get(pair[side]))}" for pair in key_pairs)


def _numeric_equal(left: Any, right: Any, tolerance: float) -> bool | None:
    """Return None for text values at zero tolerance; otherwise compare numerically."""
    try:
        if is_missing(left) or is_missing(right):
            return None
        # CSV inputs are read as text to preserve identifiers/leading zeros. Do not
        # coerce text-only values to numbers unless the user explicitly enables tolerance.
        both_numeric_cells = isinstance(left, Number) and not isinstance(left, bool) and isinstance(right, Number) and not isinstance(right, bool)
        if tolerance == 0 and not both_numeric_cells:
            return None
        left_num, right_num = float(str(left).replace(",", "")), float(str(right).replace(",", ""))
        if not (math.isfinite(left_num) and math.isfinite(right_num)):
            return None
        return abs(left_num - right_num) <= tolerance
    except (TypeError, ValueError):
        return None


def reconcile_dataframes(
    source_a: pd.DataFrame,
    source_b: pd.DataFrame,
    key_pairs: list[dict[str, str]],
    compare_pairs: list[dict[str, str]],
    *,
    trim_whitespace: bool = True,
    case_insensitive: bool = False,
    numeric_tolerance: float = 0.0,
    fuzzy_enabled: bool = False,
    fuzzy_threshold: float = 0.85,
) -> dict[str, Any]:
    """Reconcile two frames without mutating either input.

    Duplicate-key rows are deliberately excluded from automatic record matching.
    Fuzzy results are suggestions only and never change deterministic match status.
    """
    if not key_pairs:
        raise ValueError("At least one matching-key pair is required.")
    for pair in key_pairs:
        if pair.get("left") not in source_a.columns or pair.get("right") not in source_b.columns:
            raise ValueError("A matching-key column no longer exists in one of the source files.")
    for pair in compare_pairs:
        if pair.get("left") not in source_a.columns or pair.get("right") not in source_b.columns:
            raise ValueError("A comparison column no longer exists in one of the source files.")
    if numeric_tolerance < 0:
        raise ValueError("Numeric tolerance cannot be negative.")
    if not 0 <= fuzzy_threshold <= 1:
        raise ValueError("Fuzzy-match confidence threshold must be between 0 and 1.")

    rows_a = source_a.to_dict(orient="records")
    rows_b = source_b.to_dict(orient="records")
    exceptions: list[dict[str, Any]] = []
    omitted_exception_count = 0

    def add_exception(kind: str, severity: str, message: str, *, key: str = "", row_a: int | None = None,
                      row_b: int | None = None, column: str = "", value_a: Any = None,
                      value_b: Any = None, confidence: float | None = None) -> None:
        nonlocal omitted_exception_count
        item = {
            "exception_type": kind,
            "severity": severity,
            "message": message,
            "key": key,
            "source_a_row": row_a,
            "source_b_row": row_b,
            "column": column,
            "source_a_value": json_safe(value_a),
            "source_b_value": json_safe(value_b),
            "confidence": round(confidence, 4) if confidence is not None else None,
        }
        if len(exceptions) < MAX_EXCEPTIONS:
            exceptions.append(item)
        else:
            omitted_exception_count += 1

    keys_a = [_key(row, key_pairs, "left", trim_whitespace, case_insensitive) for row in rows_a]
    keys_b = [_key(row, key_pairs, "right", trim_whitespace, case_insensitive) for row in rows_b]
    groups_a: dict[tuple[str, ...], list[int]] = defaultdict(list)
    groups_b: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for i, key in enumerate(keys_a):
        if key is not None:
            groups_a[key].append(i)
    for i, key in enumerate(keys_b):
        if key is not None:
            groups_b[key].append(i)

    duplicate_keys_a = {key for key, indexes in groups_a.items() if len(indexes) > 1}
    duplicate_keys_b = {key for key, indexes in groups_b.items() if len(indexes) > 1}

    # Cell-level missing-value checks: report every empty cell; never fill values.
    missing_a = missing_b = 0
    for i, row in enumerate(rows_a):
        for column, value in row.items():
            if is_missing(value):
                missing_a += 1
                add_exception("missing_value_source_a", "warning", f"Missing value in Source A column '{column}'.",
                              row_a=i + 2, column=column, value_a=value)
    for i, row in enumerate(rows_b):
        for column, value in row.items():
            if is_missing(value):
                missing_b += 1
                add_exception("missing_value_source_b", "warning", f"Missing value in Source B column '{column}'.",
                              row_b=i + 2, column=column, value_b=value)

    # Duplicate matching keys are explicitly ambiguous and are not paired.
    duplicate_key_rows_a = duplicate_key_rows_b = 0
    for key, indexes in groups_a.items():
        if key in duplicate_keys_a:
            duplicate_key_rows_a += len(indexes)
            for i in indexes:
                add_exception("duplicate_key_source_a", "error",
                              "Matching key occurs more than once in Source A; automatic pairing was skipped.",
                              key=_key_label(rows_a[i], key_pairs, "left"), row_a=i + 2)
    for key, indexes in groups_b.items():
        if key in duplicate_keys_b:
            duplicate_key_rows_b += len(indexes)
            for i in indexes:
                add_exception("duplicate_key_source_b", "error",
                              "Matching key occurs more than once in Source B; automatic pairing was skipped.",
                              key=_key_label(rows_b[i], key_pairs, "right"), row_b=i + 2)

    # Exact whole-row duplicates are also useful data-quality signals.
    def duplicate_row_indexes(rows: list[dict[str, Any]], columns: list[str]) -> set[int]:
        groups: dict[tuple[Any, ...], list[int]] = defaultdict(list)
        for i, row in enumerate(rows):
            fingerprint = tuple(normalize_value(row.get(c), trim_whitespace, case_insensitive) for c in columns)
            groups[fingerprint].append(i)
        return {i for indexes in groups.values() if len(indexes) > 1 for i in indexes}

    duplicate_full_a = duplicate_row_indexes(rows_a, list(source_a.columns))
    duplicate_full_b = duplicate_row_indexes(rows_b, list(source_b.columns))
    for i in sorted(duplicate_full_a):
        add_exception("duplicate_row_source_a", "warning", "Entire row is duplicated in Source A.",
                      key=_key_label(rows_a[i], key_pairs, "left"), row_a=i + 2)
    for i in sorted(duplicate_full_b):
        add_exception("duplicate_row_source_b", "warning", "Entire row is duplicated in Source B.",
                      key=_key_label(rows_b[i], key_pairs, "right"), row_b=i + 2)

    # A row with a missing key cannot be matched safely.
    for i, key in enumerate(keys_a):
        if key is None:
            add_exception("missing_matching_key_source_a", "error",
                          "One or more matching-key fields are empty; record was not matched.", row_a=i + 2)
    for i, key in enumerate(keys_b):
        if key is None:
            add_exception("missing_matching_key_source_b", "error",
                          "One or more matching-key fields are empty; record was not matched.", row_b=i + 2)

    unique_a = {key: indexes[0] for key, indexes in groups_a.items() if len(indexes) == 1}
    unique_b = {key: indexes[0] for key, indexes in groups_b.items() if len(indexes) == 1}
    all_keys_a, all_keys_b = set(groups_a), set(groups_b)
    only_a_indexes: list[int] = []
    only_b_indexes: list[int] = []

    for key, i in unique_a.items():
        if key in duplicate_keys_b:
            add_exception("ambiguous_key", "error",
                          "This Source A record matches a duplicate key in Source B; review the duplicate rows.",
                          key=_key_label(rows_a[i], key_pairs, "left"), row_a=i + 2)
        elif key not in all_keys_b:
            only_a_indexes.append(i)
            add_exception("record_missing_in_source_b", "error", "Record exists in Source A but not Source B.",
                          key=_key_label(rows_a[i], key_pairs, "left"), row_a=i + 2)

    for key, i in unique_b.items():
        if key in duplicate_keys_a:
            add_exception("ambiguous_key", "error",
                          "This Source B record matches a duplicate key in Source A; review the duplicate rows.",
                          key=_key_label(rows_b[i], key_pairs, "right"), row_b=i + 2)
        elif key not in all_keys_a:
            only_b_indexes.append(i)
            add_exception("record_missing_in_source_a", "error", "Record exists in Source B but not Source A.",
                          key=_key_label(rows_b[i], key_pairs, "right"), row_b=i + 2)

    matched = 0
    records_with_differences = 0
    value_mismatches = 0
    matched_same = 0
    matched_with_missing_compared_values = 0
    # Iterate in Source A order so exception ordering is reproducible across runs.
    for key, ia in unique_a.items():
        if key not in unique_b:
            continue
        ib = unique_b[key]
        matched += 1
        row_a, row_b = rows_a[ia], rows_b[ib]
        this_record_differs = False
        this_record_has_missing_compared_value = False
        for pair in compare_pairs:
            left_col, right_col = pair["left"], pair["right"]
            left_val, right_val = row_a.get(left_col), row_b.get(right_col)
            if is_missing(left_val) or is_missing(right_val):
                # The missing-cell exception already explains the blank. The row should
                # not be counted as a clean value match when a compared field is absent.
                this_record_has_missing_compared_value = True
                continue
            numeric_result = _numeric_equal(left_val, right_val, numeric_tolerance)
            if numeric_result is not None:
                equal = numeric_result
            else:
                left_norm = normalize_value(left_val, trim_whitespace, case_insensitive)
                right_norm = normalize_value(right_val, trim_whitespace, case_insensitive)
                equal = left_norm == right_norm
            if not equal:
                value_mismatches += 1
                this_record_differs = True
                add_exception("value_mismatch", "error",
                              f"Values differ for Source A '{left_col}' and Source B '{right_col}'.",
                              key=_key_label(row_a, key_pairs, "left"), row_a=ia + 2, row_b=ib + 2,
                              column=f"{left_col} ↔ {right_col}", value_a=left_val, value_b=right_val)
        if this_record_differs:
            records_with_differences += 1
        if this_record_has_missing_compared_value:
            matched_with_missing_compared_values += 1
        if not this_record_differs and not this_record_has_missing_compared_value:
            matched_same += 1

    # Fuzzy matching is strictly advisory, never automatic reconciliation.
    fuzzy_suggestions = 0
    fuzzy_warning = None
    if fuzzy_enabled:
        if len(key_pairs) != 1:
            fuzzy_warning = "Fuzzy suggestions require exactly one matching-key pair; no suggestions were generated."
        elif len(only_a_indexes) > 5000 or len(only_b_indexes) > 5000:
            fuzzy_warning = "Fuzzy suggestions were skipped because more than 5,000 unmatched rows exist on one side."
        elif (process is None or fuzz is None) and (len(only_a_indexes) > 100 or len(only_b_indexes) > 2000):
            fuzzy_warning = "Fuzzy suggestions were skipped because the optional fast matcher is not installed for this data size."
        elif only_a_indexes and only_b_indexes:
            col_a, col_b = key_pairs[0]["left"], key_pairs[0]["right"]
            choices = {str(j): normalize_value(rows_b[j].get(col_b), trim_whitespace, case_insensitive) or ""
                       for j in only_b_indexes}
            choices = {idx: value for idx, value in choices.items() if value}
            for i in only_a_indexes:
                query = normalize_value(rows_a[i].get(col_a), trim_whitespace, case_insensitive) or ""
                if not query or not choices:
                    continue
                if process is not None and fuzz is not None:
                    best = process.extractOne(query, choices, scorer=fuzz.ratio)
                    if not best:
                        continue
                    candidate_text, score, candidate_id = best
                    confidence = float(score) / 100.0
                else:
                    candidate_id, candidate_text, confidence = max(
                        ((idx, value, SequenceMatcher(None, query, value).ratio()) for idx, value in choices.items()),
                        key=lambda item: item[2], default=(None, "", 0.0))
                if candidate_id is not None and confidence >= fuzzy_threshold:
                    j = int(candidate_id)
                    fuzzy_suggestions += 1
                    add_exception("fuzzy_match_suggestion", "info",
                                  "Fuzzy suggestion only; verify manually. Exact reconciliation status is unchanged.",
                                  key=_key_label(rows_a[i], key_pairs, "left"), row_a=i + 2, row_b=j + 2,
                                  column=f"{col_a} ↔ {col_b}", value_a=rows_a[i].get(col_a),
                                  value_b=rows_b[j].get(col_b), confidence=confidence)

    if omitted_exception_count:
        exceptions.append({
            "exception_type": "exception_details_truncated", "severity": "warning",
            "message": f"Detailed exception limit reached; {omitted_exception_count:,} additional items were counted but not individually retained.",
            "key": "", "source_a_row": None, "source_b_row": None, "column": "",
            "source_a_value": None, "source_b_value": None, "confidence": None,
        })

    exception_counts: dict[str, int] = defaultdict(int)
    for item in exceptions:
        exception_counts[item["exception_type"]] += 1

    summary = {
        "source_a_rows": len(rows_a),
        "source_b_rows": len(rows_b),
        "matched_records": matched,
        "matched_without_differences": matched_same,
        "matched_with_differences": records_with_differences,
        "matched_with_missing_compared_values": matched_with_missing_compared_values,
        "records_only_in_a": len(only_a_indexes),
        "records_only_in_b": len(only_b_indexes),
        "duplicate_key_rows_a": duplicate_key_rows_a,
        "duplicate_key_rows_b": duplicate_key_rows_b,
        "duplicate_full_rows_a": len(duplicate_full_a),
        "duplicate_full_rows_b": len(duplicate_full_b),
        "missing_values_a": missing_a,
        "missing_values_b": missing_b,
        "value_mismatches": value_mismatches,
        "fuzzy_suggestions": fuzzy_suggestions,
        "exception_count": len(exceptions),
        "omitted_exception_count": omitted_exception_count,
        "exception_counts": dict(exception_counts),
    }
    warnings = [fuzzy_warning] if fuzzy_warning else []
    if omitted_exception_count:
        warnings.append(f"{omitted_exception_count:,} exception details were omitted after reaching the safety limit.")
    return {
        "summary": summary,
        "exceptions": exceptions,
        "warnings": warnings,
        "config": {
            "key_pairs": key_pairs,
            "compare_pairs": compare_pairs,
            "trim_whitespace": trim_whitespace,
            "case_insensitive": case_insensitive,
            "numeric_tolerance": numeric_tolerance,
            "fuzzy_enabled": fuzzy_enabled,
            "fuzzy_threshold": fuzzy_threshold,
        },
    }
