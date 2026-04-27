FROM savonet/liquidsoap:v2.2.5

# The script and audio directory are volume-mounted at runtime.
# Telnet on 1234, harbor on 8005.
EXPOSE 1234 8005

CMD ["liquidsoap", "/etc/liquidsoap/radio.liq"]
