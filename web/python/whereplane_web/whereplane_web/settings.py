"""
Django settings for whereplane.xyz. Laid out like adsbee-aero's: everything from the environment,
optionally from web/.env.whereplane (gitignored; see .env.whereplane.sample).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '../../.env.whereplane')


def _flag(name: str, default: str = '') -> bool:
    return os.getenv(name, default).strip().lower() not in ('', '0', 'false', 'no', 'off')


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


SECRET_KEY = os.getenv('DJANGO_SECRET_KEY')
DEBUG = _flag('DJANGO_DEBUG')
TESTING = _flag('TESTING')
if not SECRET_KEY:
    raise RuntimeError('DJANGO_SECRET_KEY is not set. See web/.env.whereplane.sample.')

ROOT_DOMAIN = os.getenv('DJANGO_ROOT_DOMAIN', 'whereplane.xyz')
ALLOWED_HOSTS = [h.strip() for h in os.getenv(
    'DJANGO_ALLOWED_HOSTS', f'{ROOT_DOMAIN},www.{ROOT_DOMAIN},localhost,127.0.0.1').split(',') if h.strip()]
CSRF_TRUSTED_ORIGINS = [o.strip() for o in os.getenv('DJANGO_CSRF_TRUSTED_ORIGINS', '').split(',') if o.strip()] + [
    f'https://{h}' for h in ALLOWED_HOSTS]
# The container healthcheck calls http://localhost:8000/healthz.
if 'localhost' not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append('localhost')

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
# Off for the LAN preview (plain http); on behind the birdbox nginx.
HTTPS_ONLY = not (DEBUG or TESTING) and _flag('WHEREPLANE_HTTPS_ONLY', '1')
SESSION_COOKIE_SECURE = HTTPS_ONLY
CSRF_COOKIE_SECURE = HTTPS_ONLY
SESSION_COOKIE_NAME = 'whereplane_session'
CSRF_COOKIE_NAME = 'whereplane_csrf'
SESSION_COOKIE_SAMESITE = 'Lax'
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_AGE = 8 * 60 * 60
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'

INSTALLED_APPS = [
    'feeders.apps.FeedersConfig',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'whereplane_web.urls'
TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [],
    'APP_DIRS': True,
    'OPTIONS': {'context_processors': [
        'django.template.context_processors.request',
        'django.contrib.auth.context_processors.auth',
        'django.contrib.messages.context_processors.messages',
        'feeders.views.site_context',
    ]},
}]
WSGI_APPLICATION = 'whereplane_web.wsgi.application'

# Postgres (compose `db`). Tests use Postgres when POSTGRES_TEST_HOST is set (site-test), else SQLite.
_PG = {
    'ENGINE': 'django.db.backends.postgresql',
    'NAME': os.getenv('POSTGRES_DB', 'whereplane'),
    'USER': os.getenv('POSTGRES_USER', 'whereplane'),
    'PASSWORD': os.getenv('POSTGRES_PASSWORD', 'whereplane'),
}
if TESTING and not os.getenv('POSTGRES_TEST_HOST'):
    DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': BASE_DIR / 'test.sqlite3'}}
elif TESTING:
    DATABASES = {'default': {**_PG, 'HOST': os.getenv('POSTGRES_TEST_HOST'), 'PORT': os.getenv('POSTGRES_TEST_PORT', 5432)}}
else:
    DATABASES = {'default': {**_PG, 'HOST': os.getenv('POSTGRES_HOST', 'db'), 'PORT': os.getenv('POSTGRES_PORT', 5432)}}
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

CACHES = {'default': {'BACKEND': 'django.core.cache.backends.db.DatabaseCache', 'LOCATION': 'whereplane_cache'}}
if TESTING:
    CACHES = {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}}
    PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 12}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
]
LOGIN_URL = 'admin:login'

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = False
USE_TZ = True

STATIC_URL = '/static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage' if TESTING
                    else 'whitenoise.storage.CompressedStaticFilesStorage'},
}

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {'console': {'class': 'logging.StreamHandler'}},
    'root': {'handlers': ['console'], 'level': os.getenv('DJANGO_LOG_LEVEL', 'INFO')},
}

# ─── whereplane ───────────────────────────────────────────────────────────────
# The live readsb (globe container's tar1090 nginx): /data/clients.json, /data/stats.json, /re-api/.
WHEREPLANE_READSB_URL = os.getenv('WHEREPLANE_READSB_URL', 'http://host.docker.internal:80').rstrip('/')
# Seconds between per-feeder polls. Each poll sees what each feeder heard in readsb's last ~2 s.
WHEREPLANE_POLL_SECONDS = float(os.getenv('WHEREPLANE_POLL_SECONDS', '10'))
# allow.txt / deny.txt for readsbee (one UUID per line, # comments); shared with the globe stack.
WHEREPLANE_FEEDERS_DIR = Path(os.getenv('WHEREPLANE_FEEDERS_DIR', '/srv/feeders'))
# readsbee's machine-readable feeder status (rejected and flagged UUIDs), shown on /staff/ only.
WHEREPLANE_READSBEE_STATUS_FILE = os.getenv('WHEREPLANE_READSBEE_STATUS_FILE', '/readsbee-status/readsbee.json')
# Feeder IDs several bees share because their device ID was never set: accepted, left off public lists and maps,
# their page asks the owner to contact support. Comma-separated.
WHEREPLANE_UNSET_IDS = [u.strip().lower() for u in os.getenv(
    'WHEREPLANE_UNSET_IDS', 'bee00000-0000-0000-bee0-000000000000').split(',') if u.strip()]
WHEREPLANE_SUPPORT_EMAIL = os.getenv('WHEREPLANE_SUPPORT_EMAIL', 'john@pantsforbirds.com')
WHEREPLANE_GLOBE_URL = os.getenv('WHEREPLANE_GLOBE_URL', 'https://globe.whereplane.xyz').rstrip('/')
WHEREPLANE_FEED_HOST = os.getenv('WHEREPLANE_FEED_HOST', 'feed.whereplane.xyz')
