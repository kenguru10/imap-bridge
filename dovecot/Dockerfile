FROM alpine:3.19

RUN apk add --no-cache dovecot dovecot-pop3d shadow tzdata openssl

RUN addgroup -g 1000 vmail && \
    adduser -u 1000 -G vmail -D -h /var/mail vmail

RUN mkdir -p /var/mail /var/log/dovecot /run/dovecot && \
    chown -R vmail:vmail /var/mail && \
    chmod 755 /var/mail

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 143 993

ENTRYPOINT ["/entrypoint.sh"]
CMD ["dovecot", "-F"]
