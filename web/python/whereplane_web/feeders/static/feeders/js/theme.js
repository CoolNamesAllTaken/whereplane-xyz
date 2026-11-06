/*
 * Light, dark, or whatever the OS says.
 *
 * Shared byte-for-byte between gentoo and corduroy. Loaded synchronously in <head>, before the
 * stylesheets, so the first paint is already in the right theme -- a page that flashes white
 * before going dark is worse than one that is simply light.
 *
 * The preference lives in localStorage under "theme" as "light" or "dark"; absent means follow
 * the OS. Bootstrap 5.3 reads data-bs-theme on <html>; color-scheme on the same element covers
 * the blank canvas before any CSS has arrived. Printing is always light.
 */
(function () {
    var KEY = 'theme';
    var root = document.documentElement;
    var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var printing = false;

    function stored() {
        try {
            var v = localStorage.getItem(KEY);
            return v === 'light' || v === 'dark' ? v : 'system';
        } catch (e) {
            return 'system';
        }
    }

    function resolve(pref) {
        if (pref !== 'system') return pref;
        return media && media.matches ? 'dark' : 'light';
    }

    function apply() {
        var pref = stored();
        var theme = printing ? 'light' : resolve(pref);
        root.setAttribute('data-bs-theme', theme);
        root.style.colorScheme = theme;
        root.setAttribute('data-theme-pref', pref);
        var options = document.querySelectorAll('[data-theme-option]');
        for (var i = 0; i < options.length; i++) {
            var on = options[i].getAttribute('data-theme-option') === pref;
            options[i].classList.toggle('active', on);
            options[i].setAttribute('aria-current', on ? 'true' : 'false');
        }
    }

    window.setTheme = function (pref) {
        try {
            if (pref === 'light' || pref === 'dark') localStorage.setItem(KEY, pref);
            else localStorage.removeItem(KEY);
        } catch (e) { /* private mode: the choice lasts for this page */ }
        apply();
    };

    if (media) {
        if (media.addEventListener) media.addEventListener('change', apply);
        else if (media.addListener) media.addListener(apply);
    }

    window.addEventListener('beforeprint', function () { printing = true; apply(); });
    window.addEventListener('afterprint', function () { printing = false; apply(); });

    document.addEventListener('click', function (e) {
        var el = e.target.closest ? e.target.closest('[data-theme-option]') : null;
        if (!el) return;
        e.preventDefault();
        window.setTheme(el.getAttribute('data-theme-option'));
    });

    apply();
    document.addEventListener('DOMContentLoaded', apply);
})();
