// Everything about signing in to the ArcGIS Portal lives in this one file:
// registering the OAuth app (CONFIG.appId / CONFIG.portalUrl, see
// config.js), checking for an existing session, and showing a "Sign in"
// button when there isn't one. Nothing else in the app touches
// esri/IdentityManager directly.
//
// Call initAuth(onSignedIn) once at startup; onSignedIn runs the moment a
// valid Portal session is confirmed, whether that happened silently or
// through the sign-in button.

import { CONFIG } from './config.js';
import { el } from './util.js';

function showSignInError(msg) {
  el('signin-error').textContent = msg;
}

export function initAuth(onSignedIn) {
  require(['esri/arcgis/OAuthInfo', 'esri/IdentityManager', 'dojo/domReady!'], (OAuthInfo, esriId) => {
    // The popup that ArcGIS's sign-in flow opens has to redirect back to a
    // page on this same origin -- oauth-callback.html is that page. This
    // origin + path pair also has to be listed in the app's "Redirect
    // URIs" on the portal (see the note on CONFIG.appId), or the popup
    // will fail with a redirect_uri mismatch.
    const callbackUrl = new URL('jimu.js/oauth-callback.html', document.baseURI).href;
    const oauthInfo = new OAuthInfo({
      appId: CONFIG.appId,
      portalUrl: CONFIG.portalUrl,
      popup: true,
      flowType: 'auto',
      popupCallbackUrl: callbackUrl
    });
    esriId.registerOAuthInfos([oauthInfo]);

    function attemptSignIn() {
      const btn = el('signin-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      showSignInError('');

      esriId.getCredential(CONFIG.portalUrl + '/sharing', { oAuthPopupConfirmation: false }).then(() => {
        onSignedIn();
      }, (err) => {
        console.error('Sign-in failed', err);
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in to OCA Syria Portal'; }
        showSignInError('Sign-in failed (' + (err && (err.message || err.details) || err) +
          '). If a pop-up window did not appear, allow pop-ups for this site and try again.');
      });
    }

    // Silent check first -- if there's already a valid session (e.g. this
    // browser signed in recently), this resolves with no pop-up at all.
    // Only if that fails do we show a Sign In button, since a pop-up can
    // only be opened from a real click, not from code running
    // automatically on page load (browsers block that).
    el('signin-msg').textContent = 'Checking sign-in status…';
    esriId.checkSignInStatus(CONFIG.portalUrl + '/sharing').then(() => {
      onSignedIn();
    }, () => {
      el('signin-msg').innerHTML = '';
      const btn = document.createElement('button');
      btn.id = 'signin-btn';
      btn.className = 'btn primary';
      btn.style.cssText = 'padding:10px 24px;font-size:13px;flex:none;';
      btn.textContent = 'Sign in to OCA Syria Portal';
      btn.addEventListener('click', attemptSignIn);
      el('signin-msg').appendChild(btn);
    });
  });
}
