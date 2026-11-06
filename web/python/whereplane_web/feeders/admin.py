from django.contrib import admin

from . import lists
from .models import Feeder, ListEntry, Status


@admin.register(Feeder)
class FeederAdmin(admin.ModelAdmin):
    list_display = ('uuid', 'name', 'hidden', 'online', 'msgs_s', 'aircraft_now', 'last_seen')
    list_filter = ('online', 'hidden')
    list_editable = ('name', 'hidden')
    search_fields = ('uuid', 'name')
    fields = ('uuid', 'name', 'hidden', 'first_seen', 'last_seen', 'online', 'msgs_s', 'pos_s', 'aircraft_now')
    readonly_fields = ('uuid', 'first_seen', 'last_seen', 'online', 'msgs_s', 'pos_s', 'aircraft_now')


@admin.register(ListEntry)
class ListEntryAdmin(admin.ModelAdmin):
    """Same files as the staff page: every change rewrites allow.txt and deny.txt."""
    list_display = ('kind', 'uuid', 'note', 'created')
    list_filter = ('kind',)

    def save_model(self, request, obj, form, change):
        super().save_model(request, obj, form, change)
        lists.write_all()

    def delete_model(self, request, obj):
        super().delete_model(request, obj)
        lists.write_all()

    def delete_queryset(self, request, queryset):
        super().delete_queryset(request, queryset)
        lists.write_all()


@admin.register(Status)
class StatusAdmin(admin.ModelAdmin):
    list_display = ('last_poll', 'poll_ms', 'requests', 'last_error')
