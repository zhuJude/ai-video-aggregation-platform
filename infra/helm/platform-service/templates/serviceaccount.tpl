{{- if .Values.serviceAccount.create }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "platform-service.serviceAccountName" . }}
  labels:
    {{- include "platform-service.labels" . | nindent 4 }}
  annotations:
    ack.aliyun.com/role-arn: {{ required "serviceAccount.roleArn is required for RRSA" .Values.serviceAccount.roleArn | quote }}
    {{- with .Values.serviceAccount.annotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
automountServiceAccountToken: {{ .Values.serviceAccount.automount }}
{{- end }}
