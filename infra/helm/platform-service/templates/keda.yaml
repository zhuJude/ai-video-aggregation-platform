{{- if .Values.keda.enabled }}
{{- if not .Values.keda.rocketmq.topic }}
{{- fail "keda.rocketmq.topic is required" }}
{{- end }}
{{- if not .Values.keda.rocketmq.consumerGroup }}
{{- fail "keda.rocketmq.consumerGroup is required" }}
{{- end }}
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: {{ include "platform-service.fullname" . }}
  labels:
    {{- include "platform-service.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    name: {{ include "platform-service.fullname" . }}
  pollingInterval: {{ .Values.keda.pollingInterval }}
  cooldownPeriod: {{ .Values.keda.cooldownPeriod }}
  minReplicaCount: {{ .Values.keda.minReplicaCount }}
  maxReplicaCount: {{ .Values.keda.maxReplicaCount }}
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
  triggers:
    - type: prometheus
      metadata:
        serverAddress: {{ .Values.keda.prometheus.serverAddress | quote }}
        query: 'sum(rocketmq_consumer_lag{topic="{{ .Values.keda.rocketmq.topic }}",consumer_group="{{ .Values.keda.rocketmq.consumerGroup }}",endpoint="{{ .Values.keda.rocketmq.endpoint }}"})'
        threshold: {{ .Values.keda.rocketmq.lagThreshold | quote }}
        activationThreshold: {{ .Values.keda.rocketmq.activationLagThreshold | quote }}
{{- end }}
