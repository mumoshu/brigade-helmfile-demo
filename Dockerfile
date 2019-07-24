FROM quay.io/roboll/helmfile:v0.79.3

LABEL "repository"="http://github.com/mumoshu/helmfile-chatops"
LABEL "homepage"="http://github.com/mumoshu/helmfile-chatops"
LABEL "maintainer"="Yusuke KUOKA <ykuoka@gmail.com>"

# Install all packages as root
USER root

RUN helm init --client-only

# Install the cloudposse alpine repository
ADD https://apk.cloudposse.com/ops@cloudposse.com.rsa.pub /etc/apk/keys/
RUN echo "@cloudposse https://apk.cloudposse.com/3.8/vendor" >> /etc/apk/repositories

RUN apk add --update --no-cache \
  slack-notifier@cloudposse \
  github-commenter@cloudposse

RUN helm plugin install https://github.com/rimusz/helm-tiller

ENV VARIANT_VERSION 0.31.1

RUN cd /usr/local/bin && \
  curl -L https://github.com/mumoshu/variant/releases/download/v${VARIANT_VERSION}/variant_${VARIANT_VERSION}_linux_amd64.tar.gz | tar zxvf - && \
  rm README.md

CMD ["/usr/local/bin/helmfile"]
