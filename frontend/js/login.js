import { API } from './api.js';

export const AuthUI = (() => {
  const overlay = () => document.getElementById('login-overlay');
  const errorEl = () => document.getElementById('login-error');

  async function ensureAuthenticated() {
    try {
      const result = await API.getAuthStatus();
      if (result.authenticated) return true;
    } catch { /* Show the login screen below. */ }
    overlay().style.display = 'flex';
    return new Promise(resolve => {
      const form = document.getElementById('login-form');
      form.onsubmit = async event => {
        event.preventDefault();
        const password = document.getElementById('login-password').value;
        const remember = document.getElementById('login-remember').checked;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        errorEl().textContent = '';
        try {
          await API.login(password, remember);
          document.getElementById('login-password').value = '';
          overlay().style.display = 'none';
          resolve(true);
        } catch (error) {
          errorEl().textContent = error.message || '登录失败';
        } finally {
          button.disabled = false;
        }
      };
    });
  }

  async function logout() {
    await API.logout();
    window.location.reload();
  }

  return { ensureAuthenticated, logout };
})();
