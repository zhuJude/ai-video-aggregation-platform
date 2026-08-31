{{- if .Values.networkPolicy.enabled }}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "platform-service.fullname" . }}
  labels:
    {{- include "platform-service.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "platform-service.selectorLabels" . | nindent 6 }}
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              {{- toYaml .Values.networkPolicy.ingressNamespaceLabels | nindent 14 }}
      ports:
        - protocol: TCP
          port: {{ .Values.containerPort }}
  egress:
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
          podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - to:
        - namespaceSelector:
            matchLabels:
              {{- toYaml .Values.networkPolicy.egress.namespaceLabels | nindent 14 }}
      ports:
        {{- toYaml .Values.networkPolicy.egress.ports | nindent 8 }}
    {{- range .Values.networkPolicy.egress.cidrs }}
    - to:
        - ipBlock:
            cidr: {{ . | quote }}
      ports:
        {{- toYaml $.Values.networkPolicy.egress.ports | nindent 8 }}
    {{- end }}
    {{- range .Values.networkPolicy.egress.providerCidrs }}
    - to:
        - ipBlock:
            cidr: {{ . | quote }}
      ports:
        - protocol: TCP
          port: 443
    {{- end }}
{{- end }}
