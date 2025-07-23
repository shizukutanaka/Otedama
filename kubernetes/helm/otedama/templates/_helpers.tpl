{{/*
Expand the name of the chart.
*/}}
{{- define "otedama.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "otedama.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "otedama.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "otedama.labels" -}}
helm.sh/chart: {{ include "otedama.chart" . }}
{{ include "otedama.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "otedama.selectorLabels" -}}
app.kubernetes.io/name: {{ include "otedama.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "otedama.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "otedama.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Create the name of the secret to use
*/}}
{{- define "otedama.secretName" -}}
{{- if .Values.secrets.create }}
{{- include "otedama.fullname" . }}-secrets
{{- else }}
{{- .Values.secrets.existingSecret }}
{{- end }}
{{- end }}

{{/*
Get the PostgreSQL URL
*/}}
{{- define "otedama.postgresqlUrl" -}}
{{- if .Values.postgresql.enabled }}
{{- printf "postgresql://%s:%s@%s-postgresql:%d/%s" .Values.postgresql.auth.username .Values.postgresql.auth.password .Release.Name (.Values.postgresql.primary.service.port | default 5432) .Values.postgresql.auth.database }}
{{- else }}
{{- .Values.secrets.databaseUrl }}
{{- end }}
{{- end }}

{{/*
Get the Redis URL
*/}}
{{- define "otedama.redisUrl" -}}
{{- if .Values.redis.enabled }}
{{- if .Values.redis.auth.enabled }}
{{- printf "redis://:%s@%s-redis-master:%d" .Values.redis.auth.password .Release.Name (.Values.redis.master.service.port | default 6379) }}
{{- else }}
{{- printf "redis://%s-redis-master:%d" .Release.Name (.Values.redis.master.service.port | default 6379) }}
{{- end }}
{{- else }}
{{- .Values.secrets.redisUrl }}
{{- end }}
{{- end }}