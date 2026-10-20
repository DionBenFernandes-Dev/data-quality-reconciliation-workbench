import pandas as pd

from app.engine import reconcile_dataframes


def test_reconciliation_flags_duplicate_keys_missing_records_and_value_mismatch():
    a = pd.DataFrame([
        {"id": "A1", "amount": "100.00", "status": "active"},
        {"id": "A2", "amount": "200.00", "status": "active"},
        {"id": "A2", "amount": "200.00", "status": "active"},
        {"id": "A3", "amount": "", "status": "active"},
    ])
    b = pd.DataFrame([
        {"key": "A1", "amount": "101.00", "status": "active"},
        {"key": "A4", "amount": "400.00", "status": "inactive"},
    ])

    result = reconcile_dataframes(
        a, b,
        key_pairs=[{"left": "id", "right": "key"}],
        compare_pairs=[{"left": "amount", "right": "amount"}, {"left": "status", "right": "status"}],
    )
    summary = result["summary"]
    types = [item["exception_type"] for item in result["exceptions"]]

    assert summary["matched_records"] == 1
    assert summary["matched_with_differences"] == 1
    assert summary["records_only_in_b"] == 1
    assert summary["duplicate_key_rows_a"] == 2
    assert summary["missing_values_a"] == 1
    assert "value_mismatch" in types
    assert "duplicate_key_source_a" in types
    missing_b = [e for e in result["exceptions"] if e["exception_type"] == "record_missing_in_source_b"]
    assert len(missing_b) == 1 and missing_b[0]["key"] == "id=A3"  # duplicate A2 rows are not silently treated as missing
    assert "record_missing_in_source_a" in types


def test_trimming_casefolding_and_numeric_tolerance_are_explicit_options():
    a = pd.DataFrame([{"id": " X-1 ", "status": "ACTIVE", "amount": "100.00"}])
    b = pd.DataFrame([{"ref": "x-1", "status": "active", "amount": "100.04"}])
    result = reconcile_dataframes(
        a, b,
        key_pairs=[{"left": "id", "right": "ref"}],
        compare_pairs=[{"left": "status", "right": "status"}, {"left": "amount", "right": "amount"}],
        trim_whitespace=True,
        case_insensitive=True,
        numeric_tolerance=0.05,
    )
    assert result["summary"]["matched_records"] == 1
    assert result["summary"]["value_mismatches"] == 0
    assert result["summary"]["matched_without_differences"] == 1


def test_missing_matching_key_is_flagged_and_not_paired():
    a = pd.DataFrame([{"id": "", "value": "one"}])
    b = pd.DataFrame([{"id": "", "value": "one"}])
    result = reconcile_dataframes(a, b, [{"left": "id", "right": "id"}], [{"left": "value", "right": "value"}])
    types = [item["exception_type"] for item in result["exceptions"]]
    assert result["summary"]["matched_records"] == 0
    assert "missing_matching_key_source_a" in types
    assert "missing_matching_key_source_b" in types


def test_fuzzy_matching_is_a_suggestion_and_does_not_change_counts():
    a = pd.DataFrame([{"id": "ACCT-1011", "amount": "9"}])
    b = pd.DataFrame([{"id": "ACCT-101I", "amount": "9"}])
    result = reconcile_dataframes(
        a, b, [{"left": "id", "right": "id"}], [{"left": "amount", "right": "amount"}],
        fuzzy_enabled=True, fuzzy_threshold=0.75,
    )
    assert result["summary"]["matched_records"] == 0
    assert result["summary"]["records_only_in_a"] == 1
    assert result["summary"]["records_only_in_b"] == 1
    suggestions = [e for e in result["exceptions"] if e["exception_type"] == "fuzzy_match_suggestion"]
    assert suggestions
    assert suggestions[0]["confidence"] >= 0.75
    assert "suggestion" in suggestions[0]["message"].lower()


def test_missing_compared_values_do_not_count_as_clean_matches():
    a = pd.DataFrame([{"id": "1", "amount": ""}])
    b = pd.DataFrame([{"id": "1", "amount": "15"}])
    result = reconcile_dataframes(a, b, [{"left": "id", "right": "id"}], [{"left": "amount", "right": "amount"}])
    assert result["summary"]["matched_records"] == 1
    assert result["summary"]["matched_without_differences"] == 0
    assert result["summary"]["matched_with_missing_compared_values"] == 1
    assert result["summary"]["value_mismatches"] == 0


def test_zero_tolerance_does_not_coerce_text_values_and_strip_leading_zeroes():
    a = pd.DataFrame([{"id": "1", "reference": "00100"}])
    b = pd.DataFrame([{"id": "1", "reference": "100"}])
    exact = reconcile_dataframes(a, b, [{"left": "id", "right": "id"}], [{"left": "reference", "right": "reference"}])
    tolerant = reconcile_dataframes(a, b, [{"left": "id", "right": "id"}], [{"left": "reference", "right": "reference"}], numeric_tolerance=0.01)
    assert exact["summary"]["value_mismatches"] == 1
    assert tolerant["summary"]["value_mismatches"] == 0
