{
	"translatorID": "f715a5a1-c362-47cf-b736-2cb2c882b852",
	"label": "CONTENTdm",
	"creator": "Emma Reisz and Abe Jellinek",
	"target": "/digital/collection/[^/]+/id|/cdm/",
	"minVersion": "3.0",
	"maxVersion": "",
	"priority": 270,
	"inRepository": true,
	"translatorType": 4,
	"browserSupport": "gcsibv",
	"lastUpdated": "2021-07-06 17:51:22"
}

/**
	***** BEGIN LICENSE BLOCK *****

	CONTENTdm translator; Copyright © 2015-2021 Emma Reisz and Abe Jellinek
	This file is part of Zotero.

	Zotero is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	Zotero is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with Zotero.  If not, see <http://www.gnu.org/licenses/>.

	***** END LICENSE BLOCK *****
*/

/*
  ContentDM is an OCLC product used by several hundred libraries, archives and museums.
  CDM may be hosted by OCLC or by the customer.
  CDM includes an API which calls metadata as XML or JSON, but customers may disable it.
  By preference, this translator scrapes JSON from an API query (slow!).
  Even in recent CDM installs, creative uses for theoretically standardized
  field names are so common that we need a data source that includes display
  names. JSON does, XML doesn't.
*/

class CDMData {
	constructor(model) {
		let fieldsByKey = {};

		if (model.parent) {
			this.parent = new CDMData(model.parent);
		}
		
		for (let field of model.fields) {
			fieldsByKey[field.key] = field;
		}

		this.fieldsByKey = fieldsByKey;
		this.collectionName = model.collectionName;
	}
	
	static fromModel(model) {
		return new this(model);
	}
	
	static fromDoc(doc) {
		let fields = [];
		for (let tr of doc.querySelectorAll('#details table tr')) {
			let field = {};
			for (let td of tr.querySelectorAll('td')) {
				if (td.matches('.description_col1')) {
					field.key = td.id.replace(/^metadata_nickname_/, '');
					field.label = ZU.trimInternal(td.innerText);
				}
				else if (td.matches('.description_col2')) {
					field.value = ZU.trimInternal(td.innerText);
				}
			}
			fields.push(field);
		}
		
		let collectionName = text('#breadcrumb_top .action_link_10', 1);
		
		return new this({ fields, collectionName });
	}
	
	query(key) {
		if (this.parent) {
			let parentResult = this.parent.query(key);
			if (parentResult) return parentResult;
		}
		return ((this.fieldsByKey[key] || {}).value || '')
			.trim()
			.replace(/;$/, '');
	}
	
	queryByName(re) {
		if (this.parent) {
			let parentResult = this.parent.queryByName(re);
			if (parentResult) return parentResult;
		}
		for (let field of Object.values(this.fieldsByKey)) {
			if (re.test(field.label)) {
				return this.query(field.key);
			}
		}
		return '';
	}
	
	detectType() {
		let title = join(this.queryByName(/title/i, true), this.query('title', true));
		if (/\binterview\b/i.test(title)) {
			return 'interview';
		}
		
		let dataType = this.query('typea') || this.query('type');
		switch (dataType.toLowerCase()) {
			case "image":
			case "photograph":
			case "engraved portrait":
			case "negative":
				return 'artwork';
			case "interview":
				return 'interview';
			default:
				return 'document';
		}
	}
}

function detectWeb(doc, url) {
	if (url.includes("/search/") && getSearchResults(doc, true)) {
		return "multiple";
	}
	else if (url.includes('/collection/')) {
		if (url.includes('/cdm/') && doc.querySelector('#details table')) {
			// older collections
			return CDMData.fromDoc(doc).detectType();
		}
		
		for (let scriptTag of doc.querySelectorAll('script:not([src])')) {
			let code = scriptTag.innerText.trim();
			if (!code.startsWith('window.__INITIAL_STATE__')) continue;
			
			// a nasty, nasty hack to avoid calling eval.
			// we have a string that looks like
			//     JSON.parse('{"foo": "bar \'baz\'"}')
			// and we need to strip the JSON.parse, replace some weird escapes,
			// and parse it once as a JSON string literal, another time as
			// actual JSON. really stupid but it works.
			
			try {
				let string = code.match(/JSON\.parse\(['"](.+)['"]\);/)[1]
					.replace(/\\x/g, '\\u00')
					.replace(/\\'/g, "'");
				string = JSON.parse('"' + string + '"');
				
				let data = CDMData.fromModel(JSON.parse(string).item.item);
				return data.detectType();
			}
			catch (e) {
				Z.debug('Error when detecting type: ' + e);
				// it's ok, detecting the correct type for the toolbar is not
				// really that important
				return 'document';
			}
		}
	}
	return false;
}

function getSearchResults(doc, checkOnly) {
	var items = {};
	var found = false;
	var rows = doc.querySelectorAll('a.SearchResult-container');
	if (!rows.length) rows = doc.querySelectorAll('.listContentBottom a');
	for (let row of rows) {
		let href = row.href;
		let title = ZU.trimInternal(
			text(row, '.MetadataFields-header') || row.innerText);
		if (!href || !title) continue;
		if (checkOnly) return true;
		found = true;
		items[href] = title;
	}
	return found ? items : false;
}

function doWeb(doc, url) {
	if (detectWeb(doc, url) == "multiple") {
		Zotero.selectItems(getSearchResults(doc, false), function (items) {
			if (items) ZU.processDocuments(Object.keys(items), scrape);
		});
	}
	else {
		scrape(doc, url);
	}
}

function scrape(doc, url) {
	var item = new Zotero.Item();
	
	item.url = url;
	item.attachments.push({
		title: "Snapshot",
		document: doc
	});
	attachPDF(doc, item);
	
	if (url.includes('/digital/collection/')) {
		// recent (React-based) collections
		
		let jsonURL = url.replace(
			/\/digital\/collection\/([^/]+)\/id\/([^/]+).*$/,
			'/digital/api/collections/$1/items/$2/false'
		);
		
		ZU.doGet(jsonURL, function (respText) {
			let json = JSON.parse(respText);
			scrapeToItem(CDMData.fromModel(json), item);
			item.complete();
		});
	}
	else {
		// older collections
		scrapeToItem(CDMData.fromDoc(doc), item);
		item.complete();
	}
}

function scrapeToItem(data, item) {
	function query(key) {
		return data.query(key);
	}
	function queryByName(re) {
		return data.queryByName(re);
	}
	
	item.itemType = data.detectType();
	item.title = join(queryByName(/title/i), query('title')).replace(' : ', ': ');
	
	// CDM pages have zero sign of what library catalog they're displaying,
	// besides an alt-text-less logo image at the top. so we can't really fill
	// in libraryCatalog accurately here
	item.libraryCatalog = '';
	
	item.creators = [
		...cleanCreators(queryByName(/creator|author/i), 'author'),
		...cleanCreators(queryByName(/translator/i), 'translator'),
		...cleanCreators(queryByName(/series editor/i), 'seriesEditor'),
		...cleanCreators(queryByName(/^\s*editor/i), 'editor'),
		...cleanCreators(queryByName(/contributor/i), 'contributor'),
		...cleanCreators(queryByName(/interviewer/i), 'interviewer')
	];
	item.abstractNote = query('descri');
	item.language = queryByName(/language/i);
	item.archiveLocation = queryByName(/identifier/i)
		|| join(query('identi'), query('locala'));
	item.archive = data.collectionName;
	item.publisher = queryByName(/publisher/i);
	item.rights = queryByName(/rights/i);
	if (item.itemType == 'artwork') {
		item.artworkMedium = queryByName(/type/i);
	}
	item.date = ZU.strToISO(query('date') || query('dated') || query('period'));
	item.place = queryByName(/place/i);
	
	let rawTags = queryByName(/keywords|subjects/i);
	if (rawTags) {
		rawTags = rawTags.split(';');
	}
	else {
		rawTags = [
			query('subject'),
			query('subjea'),
			query('subjeb'),
			query('subjec')
		];
	}
	
	item.tags = rawTags
		.filter(x => !!x) // non-null/empty only
		.map(tag => tag.replace(/\([^)]*\)/g, ''))
		.join(';') // join all semicolon-separated tag lists together...
		.split(/[.;]/) // ...and then split again (like flatMap but worse)
		.map(tag => ({ tag: tag.trim() }));
	
	return item;
}

function cleanCreators(raw, creatorType) {
	function cleanSingle(name) {
		name = name
			.replace(/\([^)]*\)|\[[^\]]*\]|;$/g, '')
			.replace(/, Sir |, Dr /g, ', ');
			
		// if we can find a good heuristic for institutional creators, we should
		// use it here
		
		let creator = ZU.cleanAuthor(name, creatorType, true);
		if (!creator.firstName) {
			creator.fieldMode = 1;
			delete creator.firstName;
		}
		return creator;
	}
	
	return raw
		.split(';')
		.map(cleanSingle);
}

function attachPDF(doc, item) {
	var pdfObject = doc.querySelector('embed'); // Could iterate looking for multiple attachments
	if (pdfObject && pdfObject.src) { // Can't simply test for .src
		item.attachments.push({
			url: pdfObject.src,
			title: "Full Text PDF",
			mimeType: "application/pdf"
		});
		return;
	}
	
	// the procedure above will probably find nothing, because PDFs seem to be
	// embedded as static image previews with download links now
	
	let pdfLink = attr(doc, 'a[title="Download Full PDF"]', 'href');
	
	if (!pdfLink && doc.querySelector('#downloadsizemenu-side-bar')) {
		for (let link of doc.querySelectorAll('#downloadsizemenu-side-bar a')) {
			if (link.textContent.includes('All')) {
				pdfLink = link.href;
				break;
			}
		}
	}
	
	if (!pdfLink && text(doc, '.field-format .field-value').includes('application/pdf')
		&& doc.querySelector('a[aria-label="Download"]')) {
		pdfLink = attr(doc, 'a[aria-label="Download"]', 'href');
	}
	
	if (pdfLink) {
		item.attachments.push({
			url: pdfLink,
			title: "Full Text PDF",
			mimeType: "application/pdf"
		});
	}
}

function join(x, y) {
	if (x == y || !x || !y) {
		return x || y;
	}
	else {
		return `${x} (${y})`;
	}
}

/** BEGIN TEST CASES **/
var testCases = [
	{
		"type": "web",
		"url": "https://cdm15979.contentdm.oclc.org/digital/collection/p15979coll3/id/2419",
		"items": [
			{
				"itemType": "document",
				"title": "Sir Robert Hart Diary: Volume 02: February 1855-July 1855",
				"creators": [
					{
						"firstName": "Robert",
						"lastName": "Hart",
						"creatorType": "author"
					},
					{
						"lastName": "Harvard University Asia Center",
						"creatorType": "contributor",
						"fieldMode": 1
					},
					{
						"firstName": "Emma",
						"lastName": "Reisz",
						"creatorType": "contributor"
					},
					{
						"firstName": "Queen's University Belfast",
						"lastName": "Special Collections & Archives",
						"creatorType": "contributor"
					}
				],
				"date": "1855-07-29",
				"abstractNote": "Personal Diary of Sir Robert Hart (1835-1911). Transcription is reproduced by permission of the Harvard University Asia Center, edited Queen's University Belfast 2011.",
				"archive": "Hart Collection - Sir Robert Hart Diaries",
				"archiveLocation": "MS 15/1/2",
				"language": "eng",
				"publisher": "Special Collections & Archives, Queen’s University Belfast",
				"rights": "Reproduction of these materials in any format for any purpose other than personal research and study may constitute a violation of CDPA 1988 and infringement of rights associated with the materials.  Please contact us for permissions information at specialcollections@qub.ac.uk",
				"shortTitle": "Sir Robert Hart Diary",
				"url": "https://cdm15979.contentdm.oclc.org/digital/collection/p15979coll3/id/2419",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [
					{
						"tag": "China"
					}
				],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://digital.ncdcr.gov/digital/collection/p16062coll24/id/9739",
		"items": [
			{
				"itemType": "document",
				"title": "Governors' Papers: James Turner, Correspondence, 1805",
				"creators": [
					{
						"firstName": "Thomas",
						"lastName": "Brown",
						"creatorType": "author"
					},
					{
						"firstName": "James",
						"lastName": "Miller",
						"creatorType": "author"
					},
					{
						"firstName": "John",
						"lastName": "Reinhardt",
						"creatorType": "author"
					},
					{
						"firstName": "James",
						"lastName": "Rhodes",
						"creatorType": "author"
					}
				],
				"date": "1805",
				"abstractNote": "James Turner (1766-1824) was the twelfth governor of North Carolina. In 1802, John B. Ashe was elected to Governor but died before entering office. The legislative then elected Turner for three consecutive terms (1803-1805).  He resigned his governorship in 1805 to join the United States Senate where he continued until bad health forced him out of politics in 1816.",
				"archive": "Governors Papers, Historical",
				"archiveLocation": "G.P. 26-28, James Turner",
				"language": "English",
				"rights": "This item is provided courtesy of the State Archives of North Carolina and is a public record according to G.S.132.",
				"shortTitle": "Governors' Papers",
				"url": "https://digital.ncdcr.gov/digital/collection/p16062coll24/id/9739",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [
					{
						"tag": "Governors--North Carolina"
					},
					{
						"tag": "Governors--North Carolina--Correspondence"
					},
					{
						"tag": "North Carolina--History"
					},
					{
						"tag": "North Carolina--History--1775-1865"
					},
					{
						"tag": "North Carolina--Politics and government"
					},
					{
						"tag": "North Carolina--Politics and government--1775-1865"
					},
					{
						"tag": "Turner, James, 1766-1824"
					},
					{
						"tag": "Turner, James, 1766-1824--Correspondence"
					},
					{
						"tag": "United States--Politics and government"
					}
				],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://digitalcollections.missouristate.edu/digital/collection/Fruitful/id/295",
		"items": [
			{
				"itemType": "artwork",
				"title": "Peaches sprayed for curculio. Self boiled lime sulfur. Curculio free-392. Curculio-11. Dunn Orchard, Koshkonong",
				"creators": [],
				"date": "1911-08-01",
				"abstractNote": "Peach",
				"archive": "A Fruitful Heritage",
				"archiveLocation": "183",
				"artworkMedium": "image",
				"url": "https://digitalcollections.missouristate.edu/digital/collection/Fruitful/id/295",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [
					{
						"tag": "curculio, lime sulfur, sprayed"
					}
				],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://hrc.contentdm.oclc.org/digital/collection/p15878coll15/id/797/rec/58",
		"items": [
			{
				"itemType": "document",
				"title": "Handwritten letter from Norman O. Dawn to Raymond Fielding, undated",
				"creators": [
					{
						"firstName": "Norman O.",
						"lastName": "Dawn",
						"creatorType": "author"
					}
				],
				"archive": "Norman O. Dawn Collection",
				"archiveLocation": "Box 36, Folder 7",
				"language": "English",
				"rights": "http://rightsstatements.org/vocab/InC/1.0/",
				"url": "https://hrc.contentdm.oclc.org/digital/collection/p15878coll15/id/797/rec/58",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://contentdm.carleton.edu/digital/collection/NfldLibrary/id/4277/rec/2",
		"items": [
			{
				"itemType": "document",
				"title": "The Orange and Black 1916",
				"creators": [
					{
						"lastName": "1916 Senior Class of Northfield High School",
						"creatorType": "author",
						"fieldMode": 1
					}
				],
				"date": "1916-05",
				"abstractNote": "The 1916 Orange and Black Yearbook from Northfield High School.  Includes photographs of students and faculty. Sections devoted to the various classes, student activities and clubs include athletics, music, student essays and poems.  An alumni section lists the occupations of graduates from the classes of 1907 to 1915.  Also features advertisements for local businesses.",
				"archive": "N-RCDHC - Northfield Public Library",
				"archiveLocation": "PYE 372.97765 Or 1916",
				"language": "eng",
				"rights": "Use of this object is governed by U.S. and international copyright law. Contact the Northfield Public Library for permission to use this object.",
				"url": "https://contentdm.carleton.edu/digital/collection/NfldLibrary/id/4277/rec/2",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [
					{
						"tag": "Category 8 - Documentary Artifact-Book"
					}
				],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://digital.cincinnatilibrary.org/digital/collection/p16998coll27/id/2136/rec/10",
		"items": [
			{
				"itemType": "interview",
				"title": "Interview (William Thomas Ariss)",
				"creators": [
					{
						"firstName": "James",
						"lastName": "Grever",
						"creatorType": "interviewer"
					}
				],
				"date": "1936-05-24",
				"archive": "Veterans History Project",
				"url": "https://digital.cincinnatilibrary.org/digital/collection/p16998coll27/id/2136/rec/10",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					}
				],
				"tags": [
					{
						"tag": "Ariss, William Thomas"
					}
				],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "http://digital.library.stonybrook.edu/cdm/search/searchterm/cookbook/order/nosort",
		"items": "multiple"
	},
	{
		"type": "web",
		"url": "http://digital.library.stonybrook.edu/cdm/compoundobject/collection/amar/id/63405/rec/2",
		"items": [
			{
				"itemType": "document",
				"title": "A Central Asian village at the dawn of civilization, excavations at Anau, Turkmenistan (Page 1)",
				"creators": [
					{
						"firstName": "Fredrik T.",
						"lastName": "Hiebert",
						"creatorType": "author"
					},
					{
						"firstName": "K.",
						"lastName": "Kurbansakhatov",
						"creatorType": "contributor"
					}
				],
				"archive": "AMAR Archive of Mesopotamian Archaeological Reports",
				"language": "eng",
				"publisher": "Philadelphia : University of Pennsylvania Museum of Archaeology and Anthropology, c2003.",
				"rights": "May not be reused for commercial purposes.",
				"url": "http://digital.library.stonybrook.edu/cdm/compoundobject/collection/amar/id/63405/rec/2",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					},
					{
						"title": "Full Text PDF",
						"mimeType": "application/pdf"
					}
				],
				"tags": [],
				"notes": [],
				"seeAlso": []
			}
		]
	},
	{
		"type": "web",
		"url": "https://content.scu.edu/digital/collection/rms/id/60",
		"defer": true,
		"items": [
			{
				"itemType": "document",
				"title": "Curing our tunnel vision: the representation of the Ohlone in Bay Area museums",
				"creators": [
					{
						"firstName": "Amy C.",
						"lastName": "Raimundo",
						"creatorType": "author"
					},
					{
						"firstName": "Russell K.",
						"lastName": "Skowronek",
						"creatorType": "seriesEditor"
					}
				],
				"date": "1995",
				"archive": "Anthropology Research Manuscripts",
				"language": "English",
				"publisher": "Santa Clara University, Department of Anthropology and Sociology",
				"rights": "Permission to copy or publish any portion of SCU Archives materials must be given by Santa Clara University Library, Archives & Special Collections.",
				"shortTitle": "Curing our tunnel vision",
				"url": "https://content.scu.edu/digital/collection/rms/id/60",
				"attachments": [
					{
						"title": "Snapshot",
						"mimeType": "text/html"
					},
					{
						"title": "Full Text PDF",
						"mimeType": "application/pdf"
					}
				],
				"tags": [
					{
						"tag": "Costanoan Indians"
					},
					{
						"tag": "Museums--California--San Francisco Bay Area"
					}
				],
				"notes": [],
				"seeAlso": []
			}
		]
	}
]
/** END TEST CASES **/
