{{- if .Values.ingress.enabled }}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "platform-service.fullname" . }}
  labels:
    {{- include "platform-service.labels" . | nindent 4 }}
  annotations:
    alb.ingress.kubernetes.io/order: {{ ternary "20" "10" .Values.ingress.canary.enabled | quote }}
    {{- if .Values.ingress.canary.enabled }}
    alb.ingress.kubernetes.io/canary: "true"
    alb.ingress.kubernetes.io/canary-weight: {{ .Values.ingress.canary.weight | quote }}
    {{- end }}
spec:
  ingressClassName: {{ .Values.ingress.className }}
  rules:
    - host: {{ required "ingress.host is required" .Values.ingress.host | quote }}
      http:
        paths:
          - path: {{ .Values.ingress.path }}
            pathType: Prefix
            backend:
              service:
                name: {{ include "platform-service.fullname" . }}
                port:
                  number: {{ .Values.service.port }}
{{- end }}
