import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

import config

SITE = config.REPO_ROOT / "site"
PAGES = ["index", "volumes", "router", "cost", "radar", "quality", "try"]
RENDERERS = ["renderIndex", "renderVolumes", "renderRouter", "renderCost", "renderRadar",
             "renderQuality", "renderTry"]
BAD = ["undefined", "NaN", "[object Object]", ">null<", " null "]


def site_data() -> dict:
    manifest = json.loads((SITE / "data" / "manifest.json").read_text())
    data = {}
    for name in manifest["files"]:
        key = name.removesuffix(".json")
        path = SITE / "data" / name
        data["llmEval" if key == "llm_eval" else key] = json.loads(path.read_text())
    return data


def render_all(data: dict) -> dict:
    """Call every page's pure render function in Node with `data`; return page -> HTML."""
    script = (
        "const P = require(process.argv[1]); const d = JSON.parse(require('fs').readFileSync(0));"
        "const out = {};"
        f"for (const f of {json.dumps(RENDERERS)}) out[f] = P[f](d, f === 'renderVolumes' ? "
        "P.defaultFilters(d) : undefined);"
        "process.stdout.write(JSON.stringify(out));"
    )
    run = subprocess.run(["node", "-e", script, str(SITE / "js" / "pages.js")],
                         input=json.dumps(data), capture_output=True, text=True, check=True)
    return json.loads(run.stdout)


needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")


@needs_node
def test_pages_render_real_data_cleanly():
    for name, html in render_all(site_data()).items():
        assert len(html) > 200, name
        for bad in BAD:
            assert bad not in html, (name, bad)


@needs_node
def test_failures_and_missing_results_stay_visible():
    data = site_data()
    data["router"]["h2"]["pass"] = False
    data["radar"]["events"][0]["detected"] = False
    data["radar"]["novelty"] = None
    out = render_all(data)
    assert "FAIL" in out["renderIndex"]
    assert "missed" in out["renderRadar"].lower()
    for html in out.values():
        for bad in BAD:
            assert bad not in html
    data.pop("llmEval")
    data.pop("timings")
    cost = render_all(data)["renderCost"]
    assert "not run" in cost.lower() and "undefined" not in cost


@pytest.mark.parametrize("page", PAGES)
def test_html_is_local_and_has_header(page):
    html = (SITE / f"{page}.html").read_text()
    assert "<title>" in html
    assets = re.findall(r'(?:src|href)="([^"]+\.(?:css|js|woff2|svg))"', html)
    assert assets and not any(a.startswith(("http:", "https:", "//")) for a in assets)
    assert "Medhansh Shekhawat" in html
    assert "github.com/Ghostboy789/complaint-radar" in html
    assert "linkedin.com/in/" in html


def test_no_result_is_hard_coded():
    router = json.loads((SITE / "data" / "router.json").read_text())
    llm = json.loads((SITE / "data" / "llm_eval.json").read_text())
    words = router["models"]["words"]
    figures = {
        f"{words['test']['macro_f1']['value']:.3f}",
        f"{100 * router['h2']['precision']['value']:.1f}",
        f"{100 * router['h2']['coverage']['value']:.1f}",
        f"{llm['h1']['difference']['value']:.3f}",
    }
    sources = [p for p in SITE.rglob("*") if p.suffix in (".html", ".js")]
    for path in sources:
        text = path.read_text()
        for figure in figures:
            assert figure not in text, (Path(path).name, figure)
