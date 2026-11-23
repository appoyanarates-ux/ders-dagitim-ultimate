"""
Kısıt, çelişki, ön denetim, sonuç doğrulama ve süreç iptali testleri (test_constraints.py).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOLVER_DIR = os.path.join(ROOT, "solver")
if SOLVER_DIR not in sys.path:
    sys.path.insert(0, SOLVER_DIR)

from solver_ortools import ENGINE_NAME, solve_timetable
from validate_model import validate_model
from validate_result import validate_result
from test_solver import make_base_config


def test_infeasible_no_teacher():
    cfg = make_base_config(5, 6, 0)
    cfg["classes"] = [{"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"}]
    cfg["teachers"] = [{"id": "t1", "name": "Öğr 1", "branch": "Mat", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 6, "unavailable_slots": [], "prefer_avoid_slots": []}]
    cfg["assignments"] = [{
        "assignment_id": "c1__mat", "class_id": "c1", "class_name": "5/A",
        "course_id": "mat", "course_code": "MAT", "course_name": "Matematik",
        "hours": 4, "blocks": [2, 2], "teacher_ids": [],
        "room_id": None, "room_type": "standard", "max_blocks_per_day": 1, "use_common_elective_slot": False,
    }]
    res = solve_timetable(cfg)
    assert res["status"] == "INFEASIBLE"
    assert res["placements"] == []
    assert any("Öğretmen yok" in d["message"] for d in res["diagnostics"])


def test_infeasible_block_does_not_fit_lunch():
    """Öğle arası 2. dersten sonra ve günde 4 ders var -> 3 saatlik blok hiçbir yere sığmaz!"""
    cfg = make_base_config(5, 4, lunch_after=2)
    cfg["classes"] = [{"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"}]
    cfg["teachers"] = [{"id": "t1", "name": "Öğr 1", "branch": "Mat", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 4, "unavailable_slots": [], "prefer_avoid_slots": []}]
    cfg["assignments"] = [{
        "assignment_id": "c1__mat", "class_id": "c1", "class_name": "5/A",
        "course_id": "mat", "course_code": "MAT", "course_name": "Matematik",
        "hours": 3, "blocks": [3], "teacher_ids": ["t1"],
        "room_id": None, "room_type": "standard", "max_blocks_per_day": 1, "use_common_elective_slot": False,
    }]
    res = solve_timetable(cfg)
    assert res["status"] == "INFEASIBLE"
    assert res["placements"] == []
    assert any("Blok uzunluğu sığmıyor" in d["message"] for d in res["diagnostics"])


def test_infeasible_conflicting_locks():
    cfg = make_base_config(5, 6, 0)
    cfg["classes"] = [
        {"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"},
        {"id": "c2", "name": "5/B", "grade_key": "5", "shift": "full_day"},
    ]
    cfg["teachers"] = [{"id": "t1", "name": "Ayşe", "branch": "Mat", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 6, "unavailable_slots": [], "prefer_avoid_slots": []}]
    cfg["assignments"] = [
        {
            "assignment_id": "c1__mat", "class_id": "c1", "class_name": "5/A",
            "course_id": "mat", "course_code": "MAT", "course_name": "Matematik",
            "hours": 2, "blocks": [2], "teacher_ids": ["t1"],
            "room_id": None, "room_type": "standard", "max_blocks_per_day": 1, "use_common_elective_slot": False,
        },
        {
            "assignment_id": "c2__mat", "class_id": "c2", "class_name": "5/B",
            "course_id": "mat", "course_code": "MAT", "course_name": "Matematik",
            "hours": 2, "blocks": [2], "teacher_ids": ["t1"],
            "room_id": None, "room_type": "standard", "max_blocks_per_day": 1, "use_common_elective_slot": False,
        },
    ]
    cfg["fixed_assignments"] = [
        {"assignment_id": "c1__mat", "block_index": 0, "day_index": 0, "start_period": 0, "length": 2},
        {"assignment_id": "c2__mat", "block_index": 0, "day_index": 0, "start_period": 1, "length": 2},
    ]
    res = solve_timetable(cfg)
    assert res["status"] == "INFEASIBLE"
    assert any("Sabit dersler çakışıyor" in d["message"] for d in res["diagnostics"])


def test_infeasible_teacher_unavailable_no_silent_skip():
    cfg = make_base_config(5, 6, 0)
    cfg["classes"] = [{"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"}]
    # Öğretmenin tüm saatleri kapalı
    all_unavail = [{"day_index": d, "period": p} for d in range(5) for p in range(1, 7)]
    cfg["teachers"] = [{"id": "t1", "name": "Kapalı Öğr", "branch": "Fen", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 6, "unavailable_slots": all_unavail, "prefer_avoid_slots": []}]
    cfg["assignments"] = [{
        "assignment_id": "c1__fen", "class_id": "c1", "class_name": "5/A",
        "course_id": "fen", "course_code": "FEN", "course_name": "Fen",
        "hours": 2, "blocks": [2], "teacher_ids": ["t1"],
        "room_id": None, "room_type": "standard", "max_blocks_per_day": 1, "use_common_elective_slot": False,
    }]
    res = solve_timetable(cfg)
    assert res["status"] == "INFEASIBLE"
    assert res["placed_blocks"] == 0
    assert any("5/A" in d["message"] and "Kapalı Öğr" in d["message"] and "ardışık açık ders saati" in d["message"] for d in res["diagnostics"])


def test_infeasible_room_over_capacity():
    cfg = make_base_config(1, 2, 0)  # Sadece 2 saat açık
    cfg["classes"] = [
        {"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"},
        {"id": "c2", "name": "5/B", "grade_key": "5", "shift": "full_day"},
    ]
    cfg["teachers"] = [
        {"id": "t1", "name": "Öğr 1", "branch": "Bilişim", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 2, "unavailable_slots": [], "prefer_avoid_slots": []},
        {"id": "t2", "name": "Öğr 2", "branch": "Bilişim", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 2, "unavailable_slots": [], "prefer_avoid_slots": []},
    ]
    cfg["rooms"] = [{"id": "lab1", "name": "BT Lab", "room_type": "bilisim_lab", "simultaneous_capacity": 1}]
    cfg["assignments"] = [
        {"assignment_id": "c1__bt", "class_id": "c1", "class_name": "5/A", "course_id": "bt", "course_code": "BT", "course_name": "BT", "hours": 2, "blocks": [2], "teacher_ids": ["t1"], "room_id": "lab1", "room_type": "bilisim_lab", "max_blocks_per_day": 1, "use_common_elective_slot": False},
        {"assignment_id": "c2__bt", "class_id": "c2", "class_name": "5/B", "course_id": "bt", "course_code": "BT", "course_name": "BT", "hours": 2, "blocks": [2], "teacher_ids": ["t2"], "room_id": "lab1", "room_type": "bilisim_lab", "max_blocks_per_day": 1, "use_common_elective_slot": False},
    ]
    res = solve_timetable(cfg)
    assert res["status"] == "INFEASIBLE"
    assert any("Derslik bulunamıyor" in d["message"] for d in res["diagnostics"])


def test_validate_result_catches_tampered_solution():
    cfg = make_base_config(5, 6, 0)
    cfg["classes"] = [{"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"}]
    cfg["teachers"] = [{"id": "t1", "name": "Öğr 1", "branch": "Mat", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 6, "unavailable_slots": [], "prefer_avoid_slots": []}]
    cfg["assignments"] = [{
        "assignment_id": "c1__mat", "class_id": "c1", "class_name": "5/A",
        "course_id": "mat", "course_code": "MAT", "course_name": "Mat",
        "hours": 4, "blocks": [2, 2], "teacher_ids": ["t1"],
        "room_id": None, "room_type": "standard", "max_blocks_per_day": 2, "use_common_elective_slot": False,
    }]
    # Yapay olarak çakışan iki blok ve yanlış motor adı
    bad = {
        "engine": "fake_js_engine",
        "placements": [
            {"assignment_id": "c1__mat", "block_index": 0, "class_id": "c1", "course_id": "mat", "teacher_ids": ["t1"], "room_id": None, "day_index": 0, "start_period": 0, "length": 2},
            {"assignment_id": "c1__mat", "block_index": 1, "class_id": "c1", "course_id": "mat", "teacher_ids": ["t1"], "room_id": None, "day_index": 0, "start_period": 1, "length": 2},
        ],
    }
    v = validate_result(cfg, bad)
    assert not v["valid"]
    codes = {e["code"] for e in v["errors"]}
    assert "INVALID_ENGINE" in codes
    assert "CLASS_OVERLAP" in codes
    assert "TEACHER_OVERLAP" in codes


def test_cli_info_and_file_io():
    solver_py = os.path.join(SOLVER_DIR, "solver_ortools.py")
    info_proc = subprocess.run([sys.executable, solver_py, "--info"], capture_output=True, text=True, check=True)
    info = json.loads(info_proc.stdout)
    assert info["engine"] == ENGINE_NAME
    assert info["ortools_version"]

    cfg = make_base_config(5, 6, 0)
    cfg["classes"] = [{"id": "c1", "name": "5/A", "grade_key": "5", "shift": "full_day"}]
    cfg["teachers"] = [{"id": "t1", "name": "Öğr 1", "branch": "Mat", "min_weekly_hours": 0, "max_weekly_hours": 30, "max_daily_hours": 6, "unavailable_slots": [], "prefer_avoid_slots": []}]
    cfg["assignments"] = [{
        "assignment_id": "c1__mat", "class_id": "c1", "class_name": "5/A",
        "course_id": "mat", "course_code": "MAT", "course_name": "Mat",
        "hours": 2, "blocks": [2], "teacher_ids": ["t1"],
        "room_id": None, "room_type": "standard", "max_blocks_per_day": 1, "use_common_elective_slot": False,
    }]

    with tempfile.TemporaryDirectory() as tmp:
        inp = os.path.join(tmp, "in.json")
        out = os.path.join(tmp, "out.json")
        with open(inp, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        proc = subprocess.run([sys.executable, solver_py, "--input", inp, "--output", out], capture_output=True, text=True, check=True)
        assert "progress" in proc.stderr
        with open(out, "r", encoding="utf-8") as f:
            res = json.load(f)
        assert res["engine"] == ENGINE_NAME
        assert res["status"] in ("OPTIMAL", "FEASIBLE")
        assert res["placed_blocks"] == 1
