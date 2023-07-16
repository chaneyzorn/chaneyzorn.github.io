---
title: "{{ replace .Name "-" " " | title }}"
date: {{ .Date }}
draft: true
tags: ["other"]
# description: "{{ replace .Name "-" " " | title }}"
# canonicalURL: "https://chaneyzorn.github.io/posts/{{ .Name }}"
cover:
    image: "<image path/url>" # image path/url
    alt: "{{ replace .Name "-" " " | title }}" # alt text
    caption: "{{ replace .Name "-" " " | title }}" # display caption under cover
    relative: false # when using page bundles set this to true
    hidden: true # only hide on current single page
---

