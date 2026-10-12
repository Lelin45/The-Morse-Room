const form = document.querySelector('#delete-form');
const input = document.querySelector('#delete-confirmation');
const submit = form.querySelector('[type=submit]');
const status = document.querySelector('#delete-status');
const signin = document.querySelector('#delete-signin');
const retry = document.querySelector('#delete-retry');
let busy = false;

async function request(path, body) {
  const response = await fetch(`/api${path}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The account service could not be reached. Try again or use the email contact below.'); }
  if (!response.ok) throw new Error(result.error?.message || 'That did not work. Try again or use the email contact below.');
  return result;
}

function showStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('chat-error', error);
}

async function loadAccount() {
  if (busy) return;
  busy = true; form.hidden = true; signin.hidden = true; retry.hidden = true;
  showStatus('Checking your sign-in...');
  try {
    const { user } = await request('/me');
    if (user) {
      document.querySelector('#delete-account-name').textContent = user.username ? `@${user.username}` : 'your signed-in account';
      input.value = ''; submit.disabled = true; form.hidden = false;
      showStatus('Your account is ready for deletion.');
    } else {
      showStatus('Sign in to delete your chat account.'); signin.hidden = false;
    }
  } catch (error) { showStatus(error.message, true); retry.hidden = false; }
  finally { busy = false; }
}

input.addEventListener('input', () => { submit.disabled = busy || input.value !== 'DELETE'; });
retry.addEventListener('click', () => { void loadAccount(); });
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || input.value !== 'DELETE') return;
  busy = true; submit.disabled = true; input.disabled = true;
  showStatus('Deleting your account...');
  try {
    await request('/account/delete', { confirmation: 'DELETE' });
    form.hidden = true; signin.hidden = true;
    showStatus('Your chat account and its associated live data have been deleted. Your Google account and saved training progress remain unchanged.');
    window.dispatchEvent(new CustomEvent('morse-native-auth-cleared'));
  } catch (error) { showStatus(error.message, true); }
  finally { busy = false; input.disabled = false; submit.disabled = input.value !== 'DELETE'; }
});

void loadAccount();
