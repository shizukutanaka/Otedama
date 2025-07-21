{{/*
Expand the name of the chart.
*/}}
{{- define "otedama.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
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
Create the name of the PostgreSQL secret
*/}}
{{- define "otedama.postgresql.secretName" -}}
{{- if .Values.postgresql.auth.existingSecret }}
{{- .Values.postgresql.auth.existingSecret }}
{{- else }}
{{- printf "%s-postgresql" (include "otedama.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Create the PostgreSQL fullname
*/}}
{{- define "otedama.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "otedama.fullname" .) }}
{{- end }}

{{/*
Create the name of the Redis secret
*/}}
{{- define "otedama.redis.secretName" -}}
{{- if .Values.redis.auth.existingSecret }}
{{- .Values.redis.auth.existingSecret }}
{{- else }}
{{- printf "%s-redis" (include "otedama.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Create the Redis fullname
*/}}
{{- define "otedama.redis.fullname" -}}
{{- printf "%s-redis-master" (include "otedama.fullname" .) }}
{{- end }}

{{/*
Create the Redis secret password key
*/}}
{{- define "otedama.redis.secretPasswordKey" -}}
{{- if .Values.redis.auth.existingSecret }}
{{- .Values.redis.auth.existingSecretPasswordKey }}
{{- else }}
redis-password
{{- end }}
{{- end }}

{{/*
Return the proper image name
*/}}
{{- define "otedama.image" -}}
{{- $registryName := .Values.image.registry -}}
{{- $repositoryName := .Values.image.repository -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion | toString -}}
{{- if .Values.global.imageRegistry }}
    {{- printf "%s/%s:%s" .Values.global.imageRegistry $repositoryName $tag -}}
{{- else if $registryName }}
    {{- printf "%s/%s:%s" $registryName $repositoryName $tag -}}
{{- else -}}
    {{- printf "%s:%s" $repositoryName $tag -}}
{{- end -}}
{{- end -}}

{{/*
Return the proper Docker Image Registry Secret Names
*/}}
{{- define "otedama.imagePullSecrets" -}}
{{- include "common.images.pullSecrets" (dict "images" (list .Values.image) "global" .Values.global) -}}
{{- end -}}

{{/*
Compile all warnings into a single message.
*/}}
{{- define "otedama.validateValues" -}}
{{- $messages := list -}}
{{- $messages := append $messages (include "otedama.validateValues.database" .) -}}
{{- $messages := append $messages (include "otedama.validateValues.redis" .) -}}
{{- $messages := without $messages "" -}}
{{- $message := join "\n" $messages -}}

{{- if $message -}}
{{-   printf "\nVALUES VALIDATION:\n%s" $message -}}
{{- end -}}
{{- end -}}

{{/*
Validate database configuration
*/}}
{{- define "otedama.validateValues.database" -}}
{{- if and (not .Values.postgresql.enabled) (not .Values.externalDatabase.host) -}}
otedama: database
    You must enable PostgreSQL or provide an external database host.
    Please set postgresql.enabled=true or externalDatabase.host
{{- end -}}
{{- end -}}

{{/*
Validate Redis configuration
*/}}
{{- define "otedama.validateValues.redis" -}}
{{- if and (not .Values.redis.enabled) (not .Values.externalRedis.host) -}}
otedama: redis
    You must enable Redis or provide an external Redis host.
    Please set redis.enabled=true or externalRedis.host
{{- end -}}
{{- end -}}

{{/*
Create a default ingress hostname
*/}}
{{- define "otedama.defaultHost" -}}
{{- printf "%s.%s.svc.cluster.local" (include "otedama.fullname" .) .Release.Namespace -}}
{{- end -}}

{{/*
Create the ingress hostname
*/}}
{{- define "otedama.ingress.hostname" -}}
{{- .Values.ingress.hostname | default (include "otedama.defaultHost" .) -}}
{{- end -}}

{{/*
Create the TLS secret name
*/}}
{{- define "otedama.ingress.tlsSecretName" -}}
{{- .Values.ingress.tls.secretName | default (printf "%s-tls" (include "otedama.fullname" .)) -}}
{{- end -}}

{{/*
Create monitoring labels
*/}}
{{- define "otedama.monitoring.labels" -}}
{{- if .Values.monitoring.prometheus.serviceMonitor.additionalLabels }}
{{- toYaml .Values.monitoring.prometheus.serviceMonitor.additionalLabels }}
{{- end }}
app.kubernetes.io/name: {{ include "otedama.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Create backup labels
*/}}
{{- define "otedama.backup.labels" -}}
app.kubernetes.io/name: {{ include "otedama.name" . }}-backup
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: backup
{{- end -}}

{{/*
Create migration labels
*/}}
{{- define "otedama.migration.labels" -}}
app.kubernetes.io/name: {{ include "otedama.name" . }}-migration
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: migration
{{- end -}}