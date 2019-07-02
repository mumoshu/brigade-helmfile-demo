pitchme:
	gsed \
	  -e 's/^## \(.*\)/---\n@title[\1]\n\n## \1/g' \
	  -e 's/^### \(.*\)/---\n@title[\1]\n\n## \1/g' \
	  -e 's/^#### \(.*\)/---\n@title[\1]\n\n## \1/g' \
	  -e 's/^<!-- \(@.*\) -->/\1/g' \
	  README.md > PITCHME.md
