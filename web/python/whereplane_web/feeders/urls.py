from django.urls import path

from . import views

urlpatterns = [
    path('', views.home, name='home'),
    path('coverage/', views.coverage, name='coverage'),
    path('feeders/', views.feeder_list, name='feeders'),
    path('feeder/<str:uuid>/', views.feeder_page, name='feeder'),
    path('api/live.json', views.api_live, name='api_live'),
    path('api/coverage.json', views.api_coverage, name='api_coverage'),
    path('api/cell.json', views.api_cell, name='api_cell'),
    path('api/network.json', views.api_network_series, name='api_network'),
    path('api/feeder/<str:uuid>/series.json', views.api_feeder_series, name='api_feeder_series'),
    path('staff/', views.staff, name='staff'),
    path('staff/list/add', views.staff_list_add, name='staff_list_add'),
    path('staff/list/<int:pk>/remove', views.staff_list_remove, name='staff_list_remove'),
    path('staff/feeder/<int:pk>', views.staff_feeder, name='staff_feeder'),
    path('healthz', views.healthz, name='healthz'),
]
