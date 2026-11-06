from django.contrib import admin
from django.urls import include, path

admin.site.site_header = 'whereplane.xyz'
admin.site.site_title = 'whereplane.xyz'

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', include('feeders.urls')),
]
