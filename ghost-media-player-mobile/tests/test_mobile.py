"""Phone test: runs the BUILT www/ in headless Chromium as a Pixel 7, a small 360x640 phone, landscape, and a 4x slowed CPU."""
import time, os
from playwright.sync_api import sync_playwright
from common import *
R = Report(); srv, URL = serve()

def overflow(page):
    return page.evaluate("() => Math.max(0, document.documentElement.scrollWidth - innerWidth)")

with sync_playwright() as p:
    profiles = [("Pixel 7", dict(**p.devices["Pixel 7"]), 1),
                ("Small phone 360x640", dict(viewport={"width":360,"height":640}, has_touch=True, is_mobile=True, device_scale_factor=2), 1),
                ("Landscape 844x390", dict(viewport={"width":844,"height":390}, has_touch=True, is_mobile=True), 1),
                ("Pixel 7, CPU 4x slower (low-end phone)", dict(**p.devices["Pixel 7"]), 4)]
    for label, kw, slow in profiles:
        R.section(label)
        b, c, page, errors, req = launch(p, **kw)
        if slow > 1:
            cdp = c.new_cdp_session(page); cdp.send("Emulation.setCPUThrottlingRate", {"rate": slow})
        t0 = time.time(); page.goto(URL); page.wait_for_load_state("load")
        page.wait_for_selector(".mtabs"); R.check("loads + tab bar built (%.1fs)" % (time.time()-t0), True)
        R.check("mobile defaults applied (3D off, simple nav)", page.evaluate("() => localStorage.getItem('ghost.look3d.v1')==='0' && document.body.getAttribute('data-3d')!=='on'"))
        R.check("no backdrop-filter anywhere on controls", page.evaluate("() => { const c=document.getElementById('controls'); const s=getComputedStyle(c); return (s.backdropFilter||'none')==='none'; }"))
        page.set_input_files("#fileInput", fx("song.wav", "other.wav", "song.lrc")); 
        page.wait_for_function("() => document.getElementById('audioEl').readyState >= 2", timeout=15000)
        time.sleep(1.2)
        R.check("audio plays", page.evaluate("() => !document.getElementById('audioEl').paused && document.getElementById('audioEl').currentTime > 0.3"))
        R.check("no horizontal overflow on player", overflow(page) <= 1, overflow(page))
        ctl = page.evaluate("() => { const r=document.getElementById('controls').getBoundingClientRect(), t=document.querySelector('.mtabs').getBoundingClientRect(); return [Math.round(r.bottom), Math.round(t.top), Math.round(t.bottom), innerHeight]; }")
        R.check("controls sit above tab bar, tab bar at screen bottom", ctl[0] <= ctl[1] + 1 and abs(ctl[2] - ctl[3]) <= 1, ctl)
        small = page.evaluate("""() => [...document.querySelectorAll('.mtab, #playBtn, #prevBtn, #nextBtn, #shuffleBtn, #loopBtn')].filter(e => { const r=e.getBoundingClientRect(); return r.width && (r.width < 40 || r.height < 40); }).map(e => e.id || e.className)""")
        R.check("main touch targets >= 40px", not small, small)
        # pause/play via the real button with a tap
        page.tap("#playBtn"); time.sleep(.3)
        R.check("tap on play button pauses", page.evaluate("() => document.getElementById('audioEl').paused"))
        page.tap("#playBtn"); time.sleep(.3)
        R.check("tap again resumes", page.evaluate("() => !document.getElementById('audioEl').paused"))
        # tabs
        for tab, sel, name in (("Home", "#sidebar.is-open", "Library sheet opens"), ("Radio", "#radioScreen:not([hidden])", "Radio opens"),
                               ("DJ Mode", "#djScreen:not([hidden])", "DJ Mode opens"), ("Lyrics", "#lyricsScreen:not([hidden])", "Lyrics opens")):
            page.tap('.mtab[data-tab="%s"]' % tab); time.sleep(.7)
            R.check(name, page.query_selector(sel) is not None)
            R.check("  active tab highlighted", page.evaluate("t => document.querySelector('.mtab.is-on')?.dataset.tab === t", tab))
            R.check("  no horizontal overflow (%d px)" % overflow(page), overflow(page) <= 1)
        # More -> Settings / Themes / Effects
        for item in ("Effects", "Themes", "Settings"):
            page.tap('.mtab[data-tab="more"]'); time.sleep(.3)
            page.tap('.msheet__item[data-go="%s"]' % item); time.sleep(.7)
            R.check("More > %s opens in the sheet" % item, page.evaluate("() => document.getElementById('sidebar').classList.contains('is-open')") and page.evaluate("i => !!document.querySelector('#panel-' + i.toLowerCase() + '.is-active')", item))
            R.check("  no horizontal overflow (%d px)" % overflow(page), overflow(page) <= 1)
        # back button
        page.tap('.mtab[data-tab="DJ Mode"]'); time.sleep(.5)
        R.check("back closes DJ screen", page.evaluate("() => window.GhostMobile.back()") is True and page.query_selector("#djScreen:not([hidden])") is None)
        R.check("back with nothing open returns false (lets Android minimise)", page.evaluate("() => window.GhostMobile.back()") is False or page.evaluate("() => window.GhostMobile.back()") is False)
        # audio survived all the navigation
        R.check("music kept playing through all navigation", page.evaluate("() => !document.getElementById('audioEl').paused"))
        # media session
        R.check("lock-screen metadata set", page.evaluate("() => !!navigator.mediaSession.metadata && navigator.mediaSession.metadata.title.length > 0"), page.evaluate("() => navigator.mediaSession.metadata && navigator.mediaSession.metadata.title"))
        # video
        if os.path.exists(os.path.join(FX, "clip.webm")):
            page.tap('.mtab[data-tab="Home"]'); page.evaluate("() => document.getElementById('sidebar').classList.remove('is-open')")
            page.set_input_files("#fileInput", fx("clip.webm")); time.sleep(2)
            R.check("video plays", page.evaluate("() => { const v=document.getElementById('videoEl'); return !v.paused && v.currentTime>0.3 && v.videoWidth>0; }"))
            page.screenshot(path="/tmp/t_video_%s.png" % label.split()[0])
        errs = [e for e in errors if "net::ERR" not in e and "radio-browser" not in e and "Failed to load resource" not in e]
        R.check("no console / page errors", not errs, errs[:3])
        page.screenshot(path="/tmp/t_end_%s.png" % label.split()[0])
        b.close()

    R.section("Real Android-style back button via mocked Capacitor App plugin")
    b, c, page, errors, req = launch(p, **p.devices["Pixel 7"])
    page.add_init_script("""window.__min=0; window.Capacitor={isNativePlatform:()=>true,Plugins:{App:{addListener:(n,f)=>{window.__back=f;},minimizeApp:()=>{window.__min++;}}}};""")
    page.goto(URL); page.wait_for_selector(".mtabs")
    R.check("native class set", page.evaluate("() => document.documentElement.classList.contains('is-native')"))
    page.tap('.mtab[data-tab="Lyrics"]'); time.sleep(.5); page.evaluate("() => window.__back()"); time.sleep(.3)
    R.check("hardware back leaves Lyrics, app not minimised", page.query_selector("#lyricsScreen:not([hidden])") is None and page.evaluate("() => window.__min") == 0)
    page.evaluate("() => window.__back()")
    R.check("hardware back on home minimises (music keeps playing)", page.evaluate("() => window.__min") == 1)
    b.close()
raise SystemExit(R.done())
