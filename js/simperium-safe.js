/**
 * Diff Match and Patch
 *
 * Copyright 2006 Google Inc.
 * http://code.google.com/p/google-diff-match-patch/
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Computes the difference between two texts to create a patch.
 * Applies the patch onto another text, allowing for errors.
 * @author fraser@google.com (Neil Fraser)
 */

/**
 * Class containing the diff, match and patch methods.
 * @constructor
 */
function diff_match_patch() {

  // Defaults.
  // Redefine these in your program to override the defaults.

  // Number of seconds to map a diff before giving up (0 for infinity).
  this.Diff_Timeout = 1.0;
  // Cost of an empty edit operation in terms of edit characters.
  this.Diff_EditCost = 4;
  // At what point is no match declared (0.0 = perfection, 1.0 = very loose).
  this.Match_Threshold = 0.5;
  // How far to search for a match (0 = exact location, 1000+ = broad match).
  // A match this many characters away from the expected location will add
  // 1.0 to the score (0.0 is a perfect match).
  this.Match_Distance = 1000;
  // When deleting a large block of text (over ~64 characters), how close does
  // the contents have to match the expected contents. (0.0 = perfection,
  // 1.0 = very loose).  Note that Match_Threshold controls how closely the
  // end points of a delete need to match.
  this.Patch_DeleteThreshold = 0.5;
  // Chunk size for context length.
  this.Patch_Margin = 4;

  // The number of bits in an int.
  this.Match_MaxBits = 32;
}


//  DIFF FUNCTIONS


/**
 * The data structure representing a diff is an array of tuples:
 * [[DIFF_DELETE, 'Hello'], [DIFF_INSERT, 'Goodbye'], [DIFF_EQUAL, ' world.']]
 * which means: delete 'Hello', add 'Goodbye' and keep ' world.'
 */
var DIFF_DELETE = -1;
var DIFF_INSERT = 1;
var DIFF_EQUAL = 0;

/** @typedef {!Array.<number|string>} */
diff_match_patch.Diff;


/**
 * Find the differences between two texts.  Simplifies the problem by stripping
 * any common prefix or suffix off the texts before diffing.
 * @param {string} text1 Old string to be diffed.
 * @param {string} text2 New string to be diffed.
 * @param {boolean=} opt_checklines Optional speedup flag. If present and false,
 *     then don't run a line-level diff first to identify the changed areas.
 *     Defaults to true, which does a faster, slightly less optimal diff.
 * @param {number} opt_deadline Optional time when the diff should be complete
 *     by.  Used internally for recursive calls.  Users should set DiffTimeout
 *     instead.
 * @return {!Array.<!diff_match_patch.Diff>} Array of diff tuples.
 */
diff_match_patch.prototype.diff_main = function(text1, text2, opt_checklines,
    opt_deadline) {
  // Set a deadline by which time the diff must be complete.
  if (typeof opt_deadline == 'undefined') {
    if (this.Diff_Timeout <= 0) {
      opt_deadline = Number.MAX_VALUE;
    } else {
      opt_deadline = (new Date).getTime() + this.Diff_Timeout * 1000;
    }
  }
  var deadline = opt_deadline;

  // Check for null inputs.
  if (text1 == null || text2 == null) {
    throw new Error('Null input. (diff_main)');
  }

  // Check for equality (speedup).
  if (text1 == text2) {
    if (text1) {
      return [[DIFF_EQUAL, text1]];
    }
    return [];
  }

  if (typeof opt_checklines == 'undefined') {
    opt_checklines = true;
  }
  var checklines = opt_checklines;

  // Trim off common prefix (speedup).
  var commonlength = this.diff_commonPrefix(text1, text2);
  var commonprefix = text1.substring(0, commonlength);
  text1 = text1.substring(commonlength);
  text2 = text2.substring(commonlength);

  // Trim off common suffix (speedup).
  commonlength = this.diff_commonSuffix(text1, text2);
  var commonsuffix = text1.substring(text1.length - commonlength);
  text1 = text1.substring(0, text1.length - commonlength);
  text2 = text2.substring(0, text2.length - commonlength);

  // Compute the diff on the middle block.
  var diffs = this.diff_compute_(text1, text2, checklines, deadline);

  // Restore the prefix and suffix.
  if (commonprefix) {
    diffs.unshift([DIFF_EQUAL, commonprefix]);
  }
  if (commonsuffix) {
    diffs.push([DIFF_EQUAL, commonsuffix]);
  }
  this.diff_cleanupMerge(diffs);
  return diffs;
};


/**
 * Find the differences between two texts.  Assumes that the texts do not
 * have any common prefix or suffix.
 * @param {string} text1 Old string to be diffed.
 * @param {string} text2 New string to be diffed.
 * @param {boolean} checklines Speedup flag.  If false, then don't run a
 *     line-level diff first to identify the changed areas.
 *     If true, then run a faster, slightly less optimal diff.
 * @param {number} deadline Time when the diff should be complete by.
 * @return {!Array.<!diff_match_patch.Diff>} Array of diff tuples.
 * @private
 */
diff_match_patch.prototype.diff_compute_ = function(text1, text2, checklines,
    deadline) {
  var diffs;

  if (!text1) {
    // Just add some text (speedup).
    return [[DIFF_INSERT, text2]];
  }

  if (!text2) {
    // Just delete some text (speedup).
    return [[DIFF_DELETE, text1]];
  }

  var longtext = text1.length > text2.length ? text1 : text2;
  var shorttext = text1.length > text2.length ? text2 : text1;
  var i = longtext.indexOf(shorttext);
  if (i != -1) {
    // Shorter text is inside the longer text (speedup).
    diffs = [[DIFF_INSERT, longtext.substring(0, i)],
             [DIFF_EQUAL, shorttext],
             [DIFF_INSERT, longtext.substring(i + shorttext.length)]];
    // Swap insertions for deletions if diff is reversed.
    if (text1.length > text2.length) {
      diffs[0][0] = diffs[2][0] = DIFF_DELETE;
    }
    return diffs;
  }

  if (shorttext.length == 1) {
    // Single character string.
    // After the previous speedup, the character can't be an equality.
    return [[DIFF_DELETE, text1], [DIFF_INSERT, text2]];
  }
  longtext = shorttext = null;  // Garbage collect.

  // Check to see if the problem can be split in two.
  var hm = this.diff_halfMatch_(text1, text2);
  if (hm) {
    // A half-match was found, sort out the return data.
    var text1_a = hm[0];
    var text1_b = hm[1];
    var text2_a = hm[2];
    var text2_b = hm[3];
    var mid_common = hm[4];
    // Send both pairs off for separate processing.
    var diffs_a = this.diff_main(text1_a, text2_a, checklines, deadline);
    var diffs_b = this.diff_main(text1_b, text2_b, checklines, deadline);
    // Merge the results.
    return diffs_a.concat([[DIFF_EQUAL, mid_common]], diffs_b);
  }

  if (checklines && text1.length > 100 && text2.length > 100) {
    return this.diff_lineMode_(text1, text2, deadline);
  }

  return this.diff_bisect_(text1, text2, deadline);
};


/**
 * Do a quick line-level diff on both strings, then rediff the parts for
 * greater accuracy.
 * This speedup can produce non-minimal diffs.
 * @param {string} text1 Old string to be diffed.
 * @param {string} text2 New string to be diffed.
 * @param {number} deadline Time when the diff should be complete by.
 * @return {!Array.<!diff_match_patch.Diff>} Array of diff tuples.
 * @private
 */
diff_match_patch.prototype.diff_lineMode_ = function(text1, text2, deadline) {
  // Scan the text on a line-by-line basis first.
  var a = this.diff_linesToChars_(text1, text2);
  text1 = /** @type {string} */(a[0]);
  text2 = /** @type {string} */(a[1]);
  var linearray = /** @type {!Array.<string>} */(a[2]);

  var diffs = this.diff_bisect_(text1, text2, deadline);

  // Convert the diff back to original text.
  this.diff_charsToLines_(diffs, linearray);
  // Eliminate freak matches (e.g. blank lines)
  this.diff_cleanupSemantic(diffs);

  // Rediff any replacement blocks, this time character-by-character.
  // Add a dummy entry at the end.
  diffs.push([DIFF_EQUAL, '']);
  var pointer = 0;
  var count_delete = 0;
  var count_insert = 0;
  var text_delete = '';
  var text_insert = '';
  while (pointer < diffs.length) {
    switch (diffs[pointer][0]) {
      case DIFF_INSERT:
        count_insert++;
        text_insert += diffs[pointer][1];
        break;
      case DIFF_DELETE:
        count_delete++;
        text_delete += diffs[pointer][1];
        break;
      case DIFF_EQUAL:
        // Upon reaching an equality, check for prior redundancies.
        if (count_delete >= 1 && count_insert >= 1) {
          // Delete the offending records and add the merged ones.
          var a = this.diff_main(text_delete, text_insert, false, deadline);
          diffs.splice(pointer - count_delete - count_insert,
                       count_delete + count_insert);
          pointer = pointer - count_delete - count_insert;
          for (var j = a.length - 1; j >= 0; j--) {
            diffs.splice(pointer, 0, a[j]);
          }
          pointer = pointer + a.length;
        }
        count_insert = 0;
        count_delete = 0;
        text_delete = '';
        text_insert = '';
        break;
    }
    pointer++;
  }
  diffs.pop();  // Remove the dummy entry at the end.

  return diffs;
};


/**
 * Find the 'middle snake' of a diff, split the problem in two
 * and return the recursively constructed diff.
 * See Myers 1986 paper: An O(ND) Difference Algorithm and Its Variations.
 * @param {string} text1 Old string to be diffed.
 * @param {string} text2 New string to be diffed.
 * @param {number} deadline Time at which to bail if not yet complete.
 * @return {!Array.<!diff_match_patch.Diff>} Array of diff tuples.
 * @private
 */
diff_match_patch.prototype.diff_bisect_ = function(text1, text2, deadline) {
  // Cache the text lengths to prevent multiple calls.
  var text1_length = text1.length;
  var text2_length = text2.length;
  var max_d = Math.ceil((text1_length + text2_length) / 2);
  var v_offset = max_d;
  var v_length = 2 * max_d;
  var v1 = new Array(v_length);
  var v2 = new Array(v_length);
  // Setting all elements to -1 is faster in Chrome & Firefox than mixing
  // integers and undefined.
  for (var x = 0; x < v_length; x++) {
    v1[x] = -1;
    v2[x] = -1;
  }
  v1[v_offset + 1] = 0;
  v2[v_offset + 1] = 0;
  var delta = text1_length - text2_length;
  // If the total number of characters is odd, then the front path will collide
  // with the reverse path.
  var front = (delta % 2 != 0);
  // Offsets for start and end of k loop.
  // Prevents mapping of space beyond the grid.
  var k1start = 0;
  var k1end = 0;
  var k2start = 0;
  var k2end = 0;
  for (var d = 0; d < max_d; d++) {
    // Bail out if deadline is reached.
    if ((new Date()).getTime() > deadline) {
      break;
    }

    // Walk the front path one step.
    for (var k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      var k1_offset = v_offset + k1;
      var x1;
      if (k1 == -d || k1 != d && v1[k1_offset - 1] < v1[k1_offset + 1]) {
        x1 = v1[k1_offset + 1];
      } else {
        x1 = v1[k1_offset - 1] + 1;
      }
      var y1 = x1 - k1;
      while (x1 < text1_length && y1 < text2_length &&
             text1.charAt(x1) == text2.charAt(y1)) {
        x1++;
        y1++;
      }
      v1[k1_offset] = x1;
      if (x1 > text1_length) {
        // Ran off the right of the graph.
        k1end += 2;
      } else if (y1 > text2_length) {
        // Ran off the bottom of the graph.
        k1start += 2;
      } else if (front) {
        var k2_offset = v_offset + delta - k1;
        if (k2_offset >= 0 && k2_offset < v_length && v2[k2_offset] != -1) {
          // Mirror x2 onto top-left coordinate system.
          var x2 = text1_length - v2[k2_offset];
          if (x1 >= x2) {
            // Overlap detected.
            return this.diff_bisectSplit_(text1, text2, x1, y1, deadline);
          }
        }
      }
    }

    // Walk the reverse path one step.
    for (var k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      var k2_offset = v_offset + k2;
      var x2;
      if (k2 == -d || k2 != d && v2[k2_offset - 1] < v2[k2_offset + 1]) {
        x2 = v2[k2_offset + 1];
      } else {
        x2 = v2[k2_offset - 1] + 1;
      }
      var y2 = x2 - k2;
      while (x2 < text1_length && y2 < text2_length &&
             text1.charAt(text1_length - x2 - 1) ==
             text2.charAt(text2_length - y2 - 1)) {
        x2++;
        y2++;
      }
      v2[k2_offset] = x2;
      if (x2 > text1_length) {
        // Ran off the left of the graph.
        k2end += 2;
      } else if (y2 > text2_length) {
        // Ran off the top of the graph.
        k2start += 2;
      } else if (!front) {
        var k1_offset = v_offset + delta - k2;
        if (k1_offset >= 0 && k1_offset < v_length && v1[k1_offset] != -1) {
          var x1 = v1[k1_offset];
          var y1 = v_offset + x1 - k1_offset;
          // Mirror x2 onto top-left coordinate system.
          x2 = text1_length - x2;
          if (x1 >= x2) {
            // Overlap detected.
            return this.diff_bisectSplit_(text1, text2, x1, y1, deadline);
          }
        }
      }
    }
  }
  // Diff took too long and hit the deadline or
  // number of diffs equals number of characters, no commonality at all.
  return [[DIFF_DELETE, text1], [DIFF_INSERT, text2]];
};


/**
 * Given the location of the 'middle snake', split the diff in two parts
 * and recurse.
 * @param {string} text1 Old string to be diffed.
 * @param {string} text2 New string to be diffed.
 * @param {number} x Index of split point in text1.
 * @param {number} y Index of split point in text2.
 * @param {number} deadline Time at which to bail if not yet complete.
 * @return {!Array.<!diff_match_patch.Diff>} Array of diff tuples.
 * @private
 */
diff_match_patch.prototype.diff_bisectSplit_ = function(text1, text2, x, y,
    deadline) {
  var text1a = text1.substring(0, x);
  var text2a = text2.substring(0, y);
  var text1b = text1.substring(x);
  var text2b = text2.substring(y);

  // Compute both diffs serially.
  var diffs = this.diff_main(text1a, text2a, false, deadline);
  var diffsb = this.diff_main(text1b, text2b, false, deadline);

  return diffs.concat(diffsb);
};


/**
 * Split two texts into an array of strings.  Reduce the texts to a string of
 * hashes where each Unicode character represents one line.
 * @param {string} text1 First string.
 * @param {string} text2 Second string.
 * @return {!Array.<string|!Array.<string>>} Three element Array, containing the
 *     encoded text1, the encoded text2 and the array of unique strings.  The
 *     zeroth element of the array of unique strings is intentionally blank.
 * @private
 */
diff_match_patch.prototype.diff_linesToChars_ = function(text1, text2) {
  var lineArray = [];  // e.g. lineArray[4] == 'Hello\n'
  var lineHash = {};   // e.g. lineHash['Hello\n'] == 4

  // '\x00' is a valid character, but various debuggers don't like it.
  // So we'll insert a junk entry to avoid generating a null character.
  lineArray[0] = '';

  /**
   * Split a text into an array of strings.  Reduce the texts to a string of
   * hashes where each Unicode character represents one line.
   * Modifies linearray and linehash through being a closure.
   * @param {string} text String to encode.
   * @return {string} Encoded string.
   * @private
   */
  function diff_linesToCharsMunge_(text) {
    var chars = '';
    // Walk the text, pulling out a substring for each line.
    // text.split('\n') would would temporarily double our memory footprint.
    // Modifying text would create many large strings to garbage collect.
    var lineStart = 0;
    var lineEnd = -1;
    // Keeping our own length variable is faster than looking it up.
    var lineArrayLength = lineArray.length;
    while (lineEnd < text.length - 1) {
      lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd == -1) {
        lineEnd = text.length - 1;
      }
      var line = text.substring(lineStart, lineEnd + 1);
      lineStart = lineEnd + 1;

      if (lineHash.hasOwnProperty ? lineHash.hasOwnProperty(line) :
          (lineHash[line] !== undefined)) {
        chars += String.fromCharCode(lineHash[line]);
      } else {
        chars += String.fromCharCode(lineArrayLength);
        lineHash[line] = lineArrayLength;
        lineArray[lineArrayLength++] = line;
      }
    }
    return chars;
  }

  var chars1 = diff_linesToCharsMunge_(text1);
  var chars2 = diff_linesToCharsMunge_(text2);
  return [chars1, chars2, lineArray];
};


/**
 * Rehydrate the text in a diff from a string of line hashes to real lines of
 * text.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @param {!Array.<string>} lineArray Array of unique strings.
 * @private
 */
diff_match_patch.prototype.diff_charsToLines_ = function(diffs, lineArray) {
  for (var x = 0; x < diffs.length; x++) {
    var chars = diffs[x][1];
    var text = [];
    for (var y = 0; y < chars.length; y++) {
      text[y] = lineArray[chars.charCodeAt(y)];
    }
    diffs[x][1] = text.join('');
  }
};


/**
 * Determine the common prefix of two strings.
 * @param {string} text1 First string.
 * @param {string} text2 Second string.
 * @return {number} The number of characters common to the start of each
 *     string.
 */
diff_match_patch.prototype.diff_commonPrefix = function(text1, text2) {
  // Quick check for common null cases.
  if (!text1 || !text2 || text1.charAt(0) != text2.charAt(0)) {
    return 0;
  }
  // Binary search.
  // Performance analysis: http://neil.fraser.name/news/2007/10/09/
  var pointermin = 0;
  var pointermax = Math.min(text1.length, text2.length);
  var pointermid = pointermax;
  var pointerstart = 0;
  while (pointermin < pointermid) {
    if (text1.substring(pointerstart, pointermid) ==
        text2.substring(pointerstart, pointermid)) {
      pointermin = pointermid;
      pointerstart = pointermin;
    } else {
      pointermax = pointermid;
    }
    pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
  }
  return pointermid;
};


/**
 * Determine the common suffix of two strings.
 * @param {string} text1 First string.
 * @param {string} text2 Second string.
 * @return {number} The number of characters common to the end of each string.
 */
diff_match_patch.prototype.diff_commonSuffix = function(text1, text2) {
  // Quick check for common null cases.
  if (!text1 || !text2 ||
      text1.charAt(text1.length - 1) != text2.charAt(text2.length - 1)) {
    return 0;
  }
  // Binary search.
  // Performance analysis: http://neil.fraser.name/news/2007/10/09/
  var pointermin = 0;
  var pointermax = Math.min(text1.length, text2.length);
  var pointermid = pointermax;
  var pointerend = 0;
  while (pointermin < pointermid) {
    if (text1.substring(text1.length - pointermid, text1.length - pointerend) ==
        text2.substring(text2.length - pointermid, text2.length - pointerend)) {
      pointermin = pointermid;
      pointerend = pointermin;
    } else {
      pointermax = pointermid;
    }
    pointermid = Math.floor((pointermax - pointermin) / 2 + pointermin);
  }
  return pointermid;
};


/**
 * Determine if the suffix of one string is the prefix of another.
 * @param {string} text1 First string.
 * @param {string} text2 Second string.
 * @return {number} The number of characters common to the end of the first
 *     string and the start of the second string.
 * @private
 */
diff_match_patch.prototype.diff_commonOverlap_ = function(text1, text2) {
  // Cache the text lengths to prevent multiple calls.
  var text1_length = text1.length;
  var text2_length = text2.length;
  // Eliminate the null case.
  if (text1_length == 0 || text2_length == 0) {
    return 0;
  }
  // Truncate the longer string.
  if (text1_length > text2_length) {
    text1 = text1.substring(text1_length - text2_length);
  } else if (text1_length < text2_length) {
    text2 = text2.substring(0, text1_length);
  }
  var text_length = Math.min(text1_length, text2_length);
  // Quick check for the worst case.
  if (text1 == text2) {
    return text_length;
  }

  // Start by looking for a single character match
  // and increase length until no match is found.
  // Performance analysis: http://neil.fraser.name/news/2010/11/04/
  var best = 0;
  var length = 1;
  while (true) {
    var pattern = text1.substring(text_length - length);
    var found = text2.indexOf(pattern);
    if (found == -1) {
      return best;
    }
    length += found;
    if (found == 0 || text1.substring(text_length - length) ==
        text2.substring(0, length)) {
      best = length;
      length++;
    }
  }
};


/**
 * Do the two texts share a substring which is at least half the length of the
 * longer text?
 * This speedup can produce non-minimal diffs.
 * @param {string} text1 First string.
 * @param {string} text2 Second string.
 * @return {Array.<string>} Five element Array, containing the prefix of
 *     text1, the suffix of text1, the prefix of text2, the suffix of
 *     text2 and the common middle.  Or null if there was no match.
 * @private
 */
diff_match_patch.prototype.diff_halfMatch_ = function(text1, text2) {
  if (this.Diff_Timeout <= 0) {
    // Don't risk returning a non-optimal diff if we have unlimited time.
    return null;
  }
  var longtext = text1.length > text2.length ? text1 : text2;
  var shorttext = text1.length > text2.length ? text2 : text1;
  if (longtext.length < 4 || shorttext.length * 2 < longtext.length) {
    return null;  // Pointless.
  }
  var dmp = this;  // 'this' becomes 'window' in a closure.

  /**
   * Does a substring of shorttext exist within longtext such that the substring
   * is at least half the length of longtext?
   * Closure, but does not reference any external variables.
   * @param {string} longtext Longer string.
   * @param {string} shorttext Shorter string.
   * @param {number} i Start index of quarter length substring within longtext.
   * @return {Array.<string>} Five element Array, containing the prefix of
   *     longtext, the suffix of longtext, the prefix of shorttext, the suffix
   *     of shorttext and the common middle.  Or null if there was no match.
   * @private
   */
  function diff_halfMatchI_(longtext, shorttext, i) {
    // Start with a 1/4 length substring at position i as a seed.
    var seed = longtext.substring(i, i + Math.floor(longtext.length / 4));
    var j = -1;
    var best_common = '';
    var best_longtext_a, best_longtext_b, best_shorttext_a, best_shorttext_b;
    while ((j = shorttext.indexOf(seed, j + 1)) != -1) {
      var prefixLength = dmp.diff_commonPrefix(longtext.substring(i),
                                               shorttext.substring(j));
      var suffixLength = dmp.diff_commonSuffix(longtext.substring(0, i),
                                               shorttext.substring(0, j));
      if (best_common.length < suffixLength + prefixLength) {
        best_common = shorttext.substring(j - suffixLength, j) +
            shorttext.substring(j, j + prefixLength);
        best_longtext_a = longtext.substring(0, i - suffixLength);
        best_longtext_b = longtext.substring(i + prefixLength);
        best_shorttext_a = shorttext.substring(0, j - suffixLength);
        best_shorttext_b = shorttext.substring(j + prefixLength);
      }
    }
    if (best_common.length * 2 >= longtext.length) {
      return [best_longtext_a, best_longtext_b,
              best_shorttext_a, best_shorttext_b, best_common];
    } else {
      return null;
    }
  }

  // First check if the second quarter is the seed for a half-match.
  var hm1 = diff_halfMatchI_(longtext, shorttext,
                             Math.ceil(longtext.length / 4));
  // Check again based on the third quarter.
  var hm2 = diff_halfMatchI_(longtext, shorttext,
                             Math.ceil(longtext.length / 2));
  var hm;
  if (!hm1 && !hm2) {
    return null;
  } else if (!hm2) {
    hm = hm1;
  } else if (!hm1) {
    hm = hm2;
  } else {
    // Both matched.  Select the longest.
    hm = hm1[4].length > hm2[4].length ? hm1 : hm2;
  }

  // A half-match was found, sort out the return data.
  var text1_a, text1_b, text2_a, text2_b;
  if (text1.length > text2.length) {
    text1_a = hm[0];
    text1_b = hm[1];
    text2_a = hm[2];
    text2_b = hm[3];
  } else {
    text2_a = hm[0];
    text2_b = hm[1];
    text1_a = hm[2];
    text1_b = hm[3];
  }
  var mid_common = hm[4];
  return [text1_a, text1_b, text2_a, text2_b, mid_common];
};


/**
 * Reduce the number of edits by eliminating semantically trivial equalities.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 */
diff_match_patch.prototype.diff_cleanupSemantic = function(diffs) {
  var changes = false;
  var equalities = [];  // Stack of indices where equalities are found.
  var equalitiesLength = 0;  // Keeping our own length var is faster in JS.
  /** @type {?string} */
  var lastequality = null;  // Always equal to equalities[equalitiesLength-1][1]
  var pointer = 0;  // Index of current position.
  // Number of characters that changed prior to the equality.
  var length_insertions1 = 0;
  var length_deletions1 = 0;
  // Number of characters that changed after the equality.
  var length_insertions2 = 0;
  var length_deletions2 = 0;
  while (pointer < diffs.length) {
    if (diffs[pointer][0] == DIFF_EQUAL) {  // Equality found.
      equalities[equalitiesLength++] = pointer;
      length_insertions1 = length_insertions2;
      length_deletions1 = length_deletions2;
      length_insertions2 = 0;
      length_deletions2 = 0;
      lastequality = /** @type {string} */(diffs[pointer][1]);
    } else {  // An insertion or deletion.
      if (diffs[pointer][0] == DIFF_INSERT) {
        length_insertions2 += diffs[pointer][1].length;
      } else {
        length_deletions2 += diffs[pointer][1].length;
      }
      // Eliminate an equality that is smaller or equal to the edits on both
      // sides of it.
      if (lastequality !== null && (lastequality.length <=
          Math.max(length_insertions1, length_deletions1)) &&
          (lastequality.length <= Math.max(length_insertions2,
                                           length_deletions2))) {
        // Duplicate record.
        diffs.splice(equalities[equalitiesLength - 1], 0,
                     [DIFF_DELETE, lastequality]);
        // Change second copy to insert.
        diffs[equalities[equalitiesLength - 1] + 1][0] = DIFF_INSERT;
        // Throw away the equality we just deleted.
        equalitiesLength--;
        // Throw away the previous equality (it needs to be reevaluated).
        equalitiesLength--;
        pointer = equalitiesLength > 0 ? equalities[equalitiesLength - 1] : -1;
        length_insertions1 = 0;  // Reset the counters.
        length_deletions1 = 0;
        length_insertions2 = 0;
        length_deletions2 = 0;
        lastequality = null;
        changes = true;
      }
    }
    pointer++;
  }

  // Normalize the diff.
  if (changes) {
    this.diff_cleanupMerge(diffs);
  }
  this.diff_cleanupSemanticLossless(diffs);

  // Find any overlaps between deletions and insertions.
  // e.g: <del>abcxxx</del><ins>xxxdef</ins>
  //   -> <del>abc</del>xxx<ins>def</ins>
  // e.g: <del>xxxabc</del><ins>defxxx</ins>
  //   -> <ins>def</ins>xxx<del>abc</del>
  // Only extract an overlap if it is as big as the edit ahead or behind it.
  pointer = 1;
  while (pointer < diffs.length) {
    if (diffs[pointer - 1][0] == DIFF_DELETE &&
        diffs[pointer][0] == DIFF_INSERT) {
      var deletion = /** @type {string} */(diffs[pointer - 1][1]);
      var insertion = /** @type {string} */(diffs[pointer][1]);
      var overlap_length1 = this.diff_commonOverlap_(deletion, insertion);
      var overlap_length2 = this.diff_commonOverlap_(insertion, deletion);
      if (overlap_length1 >= overlap_length2) {
        if (overlap_length1 >= deletion.length / 2 ||
            overlap_length1 >= insertion.length / 2) {
          // Overlap found.  Insert an equality and trim the surrounding edits.
          diffs.splice(pointer, 0,
              [DIFF_EQUAL, insertion.substring(0, overlap_length1)]);
          diffs[pointer - 1][1] =
              deletion.substring(0, deletion.length - overlap_length1);
          diffs[pointer + 1][1] = insertion.substring(overlap_length1);
          pointer++;
        }
      } else {
        if (overlap_length2 >= deletion.length / 2 ||
            overlap_length2 >= insertion.length / 2) {
          // Reverse overlap found.
          // Insert an equality and swap and trim the surrounding edits.
          diffs.splice(pointer, 0,
              [DIFF_EQUAL, deletion.substring(0, overlap_length2)]);
          diffs[pointer - 1] = [DIFF_INSERT,
              insertion.substring(0, insertion.length - overlap_length2)];
          diffs[pointer + 1] = [DIFF_DELETE,
              deletion.substring(overlap_length2)];
          pointer++;
        }
      }
      pointer++;
    }
    pointer++;
  }
};


/**
 * Look for single edits surrounded on both sides by equalities
 * which can be shifted sideways to align the edit to a word boundary.
 * e.g: The c<ins>at c</ins>ame. -> The <ins>cat </ins>came.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 */
diff_match_patch.prototype.diff_cleanupSemanticLossless = function(diffs) {
  /**
   * Given two strings, compute a score representing whether the internal
   * boundary falls on logical boundaries.
   * Scores range from 6 (best) to 0 (worst).
   * Closure, but does not reference any external variables.
   * @param {string} one First string.
   * @param {string} two Second string.
   * @return {number} The score.
   * @private
   */
  function diff_cleanupSemanticScore_(one, two) {
    if (!one || !two) {
      // Edges are the best.
      return 6;
    }

    // Each port of this function behaves slightly differently due to
    // subtle differences in each language's definition of things like
    // 'whitespace'.  Since this function's purpose is largely cosmetic,
    // the choice has been made to use each language's native features
    // rather than force total conformity.
    var char1 = one.charAt(one.length - 1);
    var char2 = two.charAt(0);
    var nonAlphaNumeric1 = char1.match(diff_match_patch.nonAlphaNumericRegex_);
    var nonAlphaNumeric2 = char2.match(diff_match_patch.nonAlphaNumericRegex_);
    var whitespace1 = nonAlphaNumeric1 &&
        char1.match(diff_match_patch.whitespaceRegex_);
    var whitespace2 = nonAlphaNumeric2 &&
        char2.match(diff_match_patch.whitespaceRegex_);
    var lineBreak1 = whitespace1 &&
        char1.match(diff_match_patch.linebreakRegex_);
    var lineBreak2 = whitespace2 &&
        char2.match(diff_match_patch.linebreakRegex_);
    var blankLine1 = lineBreak1 &&
        one.match(diff_match_patch.blanklineEndRegex_);
    var blankLine2 = lineBreak2 &&
        two.match(diff_match_patch.blanklineStartRegex_);

    if (blankLine1 || blankLine2) {
      // Five points for blank lines.
      return 5;
    } else if (lineBreak1 || lineBreak2) {
      // Four points for line breaks.
      return 4;
    } else if (nonAlphaNumeric1 && !whitespace1 && whitespace2) {
      // Three points for end of sentences.
      return 3;
    } else if (whitespace1 || whitespace2) {
      // Two points for whitespace.
      return 2;
    } else if (nonAlphaNumeric1 || nonAlphaNumeric2) {
      // One point for non-alphanumeric.
      return 1;
    }
    return 0;
  }

  var pointer = 1;
  // Intentionally ignore the first and last element (don't need checking).
  while (pointer < diffs.length - 1) {
    if (diffs[pointer - 1][0] == DIFF_EQUAL &&
        diffs[pointer + 1][0] == DIFF_EQUAL) {
      // This is a single edit surrounded by equalities.
      var equality1 = /** @type {string} */(diffs[pointer - 1][1]);
      var edit = /** @type {string} */(diffs[pointer][1]);
      var equality2 = /** @type {string} */(diffs[pointer + 1][1]);

      // First, shift the edit as far left as possible.
      var commonOffset = this.diff_commonSuffix(equality1, edit);
      if (commonOffset) {
        var commonString = edit.substring(edit.length - commonOffset);
        equality1 = equality1.substring(0, equality1.length - commonOffset);
        edit = commonString + edit.substring(0, edit.length - commonOffset);
        equality2 = commonString + equality2;
      }

      // Second, step character by character right, looking for the best fit.
      var bestEquality1 = equality1;
      var bestEdit = edit;
      var bestEquality2 = equality2;
      var bestScore = diff_cleanupSemanticScore_(equality1, edit) +
          diff_cleanupSemanticScore_(edit, equality2);
      while (edit.charAt(0) === equality2.charAt(0)) {
        equality1 += edit.charAt(0);
        edit = edit.substring(1) + equality2.charAt(0);
        equality2 = equality2.substring(1);
        var score = diff_cleanupSemanticScore_(equality1, edit) +
            diff_cleanupSemanticScore_(edit, equality2);
        // The >= encourages trailing rather than leading whitespace on edits.
        if (score >= bestScore) {
          bestScore = score;
          bestEquality1 = equality1;
          bestEdit = edit;
          bestEquality2 = equality2;
        }
      }

      if (diffs[pointer - 1][1] != bestEquality1) {
        // We have an improvement, save it back to the diff.
        if (bestEquality1) {
          diffs[pointer - 1][1] = bestEquality1;
        } else {
          diffs.splice(pointer - 1, 1);
          pointer--;
        }
        diffs[pointer][1] = bestEdit;
        if (bestEquality2) {
          diffs[pointer + 1][1] = bestEquality2;
        } else {
          diffs.splice(pointer + 1, 1);
          pointer--;
        }
      }
    }
    pointer++;
  }
};

// Define some regex patterns for matching boundaries.
diff_match_patch.nonAlphaNumericRegex_ = /[^a-zA-Z0-9]/;
diff_match_patch.whitespaceRegex_ = /\s/;
diff_match_patch.linebreakRegex_ = /[\r\n]/;
diff_match_patch.blanklineEndRegex_ = /\n\r?\n$/;
diff_match_patch.blanklineStartRegex_ = /^\r?\n\r?\n/;

/**
 * Reduce the number of edits by eliminating operationally trivial equalities.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 */
diff_match_patch.prototype.diff_cleanupEfficiency = function(diffs) {
  var changes = false;
  var equalities = [];  // Stack of indices where equalities are found.
  var equalitiesLength = 0;  // Keeping our own length var is faster in JS.
  var lastequality = '';  // Always equal to equalities[equalitiesLength-1][1]
  var pointer = 0;  // Index of current position.
  // Is there an insertion operation before the last equality.
  var pre_ins = false;
  // Is there a deletion operation before the last equality.
  var pre_del = false;
  // Is there an insertion operation after the last equality.
  var post_ins = false;
  // Is there a deletion operation after the last equality.
  var post_del = false;
  while (pointer < diffs.length) {
    if (diffs[pointer][0] == DIFF_EQUAL) {  // Equality found.
      if (diffs[pointer][1].length < this.Diff_EditCost &&
          (post_ins || post_del)) {
        // Candidate found.
        equalities[equalitiesLength++] = pointer;
        pre_ins = post_ins;
        pre_del = post_del;
        lastequality = diffs[pointer][1];
      } else {
        // Not a candidate, and can never become one.
        equalitiesLength = 0;
        lastequality = '';
      }
      post_ins = post_del = false;
    } else {  // An insertion or deletion.
      if (diffs[pointer][0] == DIFF_DELETE) {
        post_del = true;
      } else {
        post_ins = true;
      }
      /*
       * Five types to be split:
       * <ins>A</ins><del>B</del>XY<ins>C</ins><del>D</del>
       * <ins>A</ins>X<ins>C</ins><del>D</del>
       * <ins>A</ins><del>B</del>X<ins>C</ins>
       * <ins>A</del>X<ins>C</ins><del>D</del>
       * <ins>A</ins><del>B</del>X<del>C</del>
       */
      if (lastequality && ((pre_ins && pre_del && post_ins && post_del) ||
                           ((lastequality.length < this.Diff_EditCost / 2) &&
                            (pre_ins + pre_del + post_ins + post_del) == 3))) {
        // Duplicate record.
        diffs.splice(equalities[equalitiesLength - 1], 0,
                     [DIFF_DELETE, lastequality]);
        // Change second copy to insert.
        diffs[equalities[equalitiesLength - 1] + 1][0] = DIFF_INSERT;
        equalitiesLength--;  // Throw away the equality we just deleted;
        lastequality = '';
        if (pre_ins && pre_del) {
          // No changes made which could affect previous entry, keep going.
          post_ins = post_del = true;
          equalitiesLength = 0;
        } else {
          equalitiesLength--;  // Throw away the previous equality.
          pointer = equalitiesLength > 0 ?
              equalities[equalitiesLength - 1] : -1;
          post_ins = post_del = false;
        }
        changes = true;
      }
    }
    pointer++;
  }

  if (changes) {
    this.diff_cleanupMerge(diffs);
  }
};


/**
 * Reorder and merge like edit sections.  Merge equalities.
 * Any edit section can move as long as it doesn't cross an equality.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 */
diff_match_patch.prototype.diff_cleanupMerge = function(diffs) {
  diffs.push([DIFF_EQUAL, '']);  // Add a dummy entry at the end.
  var pointer = 0;
  var count_delete = 0;
  var count_insert = 0;
  var text_delete = '';
  var text_insert = '';
  var commonlength;
  while (pointer < diffs.length) {
    switch (diffs[pointer][0]) {
      case DIFF_INSERT:
        count_insert++;
        text_insert += diffs[pointer][1];
        pointer++;
        break;
      case DIFF_DELETE:
        count_delete++;
        text_delete += diffs[pointer][1];
        pointer++;
        break;
      case DIFF_EQUAL:
        // Upon reaching an equality, check for prior redundancies.
        if (count_delete + count_insert > 1) {
          if (count_delete !== 0 && count_insert !== 0) {
            // Factor out any common prefixies.
            commonlength = this.diff_commonPrefix(text_insert, text_delete);
            if (commonlength !== 0) {
              if ((pointer - count_delete - count_insert) > 0 &&
                  diffs[pointer - count_delete - count_insert - 1][0] ==
                  DIFF_EQUAL) {
                diffs[pointer - count_delete - count_insert - 1][1] +=
                    text_insert.substring(0, commonlength);
              } else {
                diffs.splice(0, 0, [DIFF_EQUAL,
                                    text_insert.substring(0, commonlength)]);
                pointer++;
              }
              text_insert = text_insert.substring(commonlength);
              text_delete = text_delete.substring(commonlength);
            }
            // Factor out any common suffixies.
            commonlength = this.diff_commonSuffix(text_insert, text_delete);
            if (commonlength !== 0) {
              diffs[pointer][1] = text_insert.substring(text_insert.length -
                  commonlength) + diffs[pointer][1];
              text_insert = text_insert.substring(0, text_insert.length -
                  commonlength);
              text_delete = text_delete.substring(0, text_delete.length -
                  commonlength);
            }
          }
          // Delete the offending records and add the merged ones.
          if (count_delete === 0) {
            diffs.splice(pointer - count_delete - count_insert,
                count_delete + count_insert, [DIFF_INSERT, text_insert]);
          } else if (count_insert === 0) {
            diffs.splice(pointer - count_delete - count_insert,
                count_delete + count_insert, [DIFF_DELETE, text_delete]);
          } else {
            diffs.splice(pointer - count_delete - count_insert,
                count_delete + count_insert, [DIFF_DELETE, text_delete],
                [DIFF_INSERT, text_insert]);
          }
          pointer = pointer - count_delete - count_insert +
                    (count_delete ? 1 : 0) + (count_insert ? 1 : 0) + 1;
        } else if (pointer !== 0 && diffs[pointer - 1][0] == DIFF_EQUAL) {
          // Merge this equality with the previous one.
          diffs[pointer - 1][1] += diffs[pointer][1];
          diffs.splice(pointer, 1);
        } else {
          pointer++;
        }
        count_insert = 0;
        count_delete = 0;
        text_delete = '';
        text_insert = '';
        break;
    }
  }
  if (diffs[diffs.length - 1][1] === '') {
    diffs.pop();  // Remove the dummy entry at the end.
  }

  // Second pass: look for single edits surrounded on both sides by equalities
  // which can be shifted sideways to eliminate an equality.
  // e.g: A<ins>BA</ins>C -> <ins>AB</ins>AC
  var changes = false;
  pointer = 1;
  // Intentionally ignore the first and last element (don't need checking).
  while (pointer < diffs.length - 1) {
    if (diffs[pointer - 1][0] == DIFF_EQUAL &&
        diffs[pointer + 1][0] == DIFF_EQUAL) {
      // This is a single edit surrounded by equalities.
      if (diffs[pointer][1].substring(diffs[pointer][1].length -
          diffs[pointer - 1][1].length) == diffs[pointer - 1][1]) {
        // Shift the edit over the previous equality.
        diffs[pointer][1] = diffs[pointer - 1][1] +
            diffs[pointer][1].substring(0, diffs[pointer][1].length -
                                        diffs[pointer - 1][1].length);
        diffs[pointer + 1][1] = diffs[pointer - 1][1] + diffs[pointer + 1][1];
        diffs.splice(pointer - 1, 1);
        changes = true;
      } else if (diffs[pointer][1].substring(0, diffs[pointer + 1][1].length) ==
          diffs[pointer + 1][1]) {
        // Shift the edit over the next equality.
        diffs[pointer - 1][1] += diffs[pointer + 1][1];
        diffs[pointer][1] =
            diffs[pointer][1].substring(diffs[pointer + 1][1].length) +
            diffs[pointer + 1][1];
        diffs.splice(pointer + 1, 1);
        changes = true;
      }
    }
    pointer++;
  }
  // If shifts were made, the diff needs reordering and another shift sweep.
  if (changes) {
    this.diff_cleanupMerge(diffs);
  }
};


/**
 * loc is a location in text1, compute and return the equivalent location in
 * text2.
 * e.g. 'The cat' vs 'The big cat', 1->1, 5->8
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @param {number} loc Location within text1.
 * @return {number} Location within text2.
 */
diff_match_patch.prototype.diff_xIndex = function(diffs, loc) {
  var chars1 = 0;
  var chars2 = 0;
  var last_chars1 = 0;
  var last_chars2 = 0;
  var x;
  for (x = 0; x < diffs.length; x++) {
    if (diffs[x][0] !== DIFF_INSERT) {  // Equality or deletion.
      chars1 += diffs[x][1].length;
    }
    if (diffs[x][0] !== DIFF_DELETE) {  // Equality or insertion.
      chars2 += diffs[x][1].length;
    }
    if (chars1 > loc) {  // Overshot the location.
      break;
    }
    last_chars1 = chars1;
    last_chars2 = chars2;
  }
  // Was the location was deleted?
  if (diffs.length != x && diffs[x][0] === DIFF_DELETE) {
    return last_chars2;
  }
  // Add the remaining character length.
  return last_chars2 + (loc - last_chars1);
};


/**
 * Convert a diff array into a pretty HTML report.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @return {string} HTML representation.
 */
diff_match_patch.prototype.diff_prettyHtml = function(diffs) {
  var html = [];
  var pattern_amp = /&/g;
  var pattern_lt = /</g;
  var pattern_gt = />/g;
  var pattern_para = /\n/g;
  for (var x = 0; x < diffs.length; x++) {
    var op = diffs[x][0];    // Operation (insert, delete, equal)
    var data = diffs[x][1];  // Text of change.
    var text = data.replace(pattern_amp, '&amp;').replace(pattern_lt, '&lt;')
        .replace(pattern_gt, '&gt;').replace(pattern_para, '&para;<br>');
    switch (op) {
      case DIFF_INSERT:
        html[x] = '<ins style="background:#e6ffe6;">' + text + '</ins>';
        break;
      case DIFF_DELETE:
        html[x] = '<del style="background:#ffe6e6;">' + text + '</del>';
        break;
      case DIFF_EQUAL:
        html[x] = '<span>' + text + '</span>';
        break;
    }
  }
  return html.join('');
};


/**
 * Compute and return the source text (all equalities and deletions).
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @return {string} Source text.
 */
diff_match_patch.prototype.diff_text1 = function(diffs) {
  var text = [];
  for (var x = 0; x < diffs.length; x++) {
    if (diffs[x][0] !== DIFF_INSERT) {
      text[x] = diffs[x][1];
    }
  }
  return text.join('');
};


/**
 * Compute and return the destination text (all equalities and insertions).
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @return {string} Destination text.
 */
diff_match_patch.prototype.diff_text2 = function(diffs) {
  var text = [];
  for (var x = 0; x < diffs.length; x++) {
    if (diffs[x][0] !== DIFF_DELETE) {
      text[x] = diffs[x][1];
    }
  }
  return text.join('');
};


/**
 * Compute the Levenshtein distance; the number of inserted, deleted or
 * substituted characters.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @return {number} Number of changes.
 */
diff_match_patch.prototype.diff_levenshtein = function(diffs) {
  var levenshtein = 0;
  var insertions = 0;
  var deletions = 0;
  for (var x = 0; x < diffs.length; x++) {
    var op = diffs[x][0];
    var data = diffs[x][1];
    switch (op) {
      case DIFF_INSERT:
        insertions += data.length;
        break;
      case DIFF_DELETE:
        deletions += data.length;
        break;
      case DIFF_EQUAL:
        // A deletion and an insertion is one substitution.
        levenshtein += Math.max(insertions, deletions);
        insertions = 0;
        deletions = 0;
        break;
    }
  }
  levenshtein += Math.max(insertions, deletions);
  return levenshtein;
};


/**
 * Crush the diff into an encoded string which describes the operations
 * required to transform text1 into text2.
 * E.g. =3\t-2\t+ing  -> Keep 3 chars, delete 2 chars, insert 'ing'.
 * Operations are tab-separated.  Inserted text is escaped using %xx notation.
 * @param {!Array.<!diff_match_patch.Diff>} diffs Array of diff tuples.
 * @return {string} Delta text.
 */
diff_match_patch.prototype.diff_toDelta = function(diffs) {
  var text = [];
  for (var x = 0; x < diffs.length; x++) {
    switch (diffs[x][0]) {
      case DIFF_INSERT:
        text[x] = '+' + encodeURI(diffs[x][1]);
        break;
      case DIFF_DELETE:
        text[x] = '-' + diffs[x][1].length;
        break;
      case DIFF_EQUAL:
        text[x] = '=' + diffs[x][1].length;
        break;
    }
  }
  return text.join('\t').replace(/%20/g, ' ');
};


/**
 * Given the original text1, and an encoded string which describes the
 * operations required to transform text1 into text2, compute the full diff.
 * @param {string} text1 Source string for the diff.
 * @param {string} delta Delta text.
 * @return {!Array.<!diff_match_patch.Diff>} Array of diff tuples.
 * @throws {!Error} If invalid input.
 */
diff_match_patch.prototype.diff_fromDelta = function(text1, delta) {
  var diffs = [];
  var diffsLength = 0;  // Keeping our own length var is faster in JS.
  var pointer = 0;  // Cursor in text1
  var tokens = delta.split(/\t/g);
  for (var x = 0; x < tokens.length; x++) {
    // Each token begins with a one character parameter which specifies the
    // operation of this token (delete, insert, equality).
    var param = tokens[x].substring(1);
    switch (tokens[x].charAt(0)) {
      case '+':
        try {
          diffs[diffsLength++] = [DIFF_INSERT, decodeURI(param)];
        } catch (ex) {
          // Malformed URI sequence.
          throw new Error('Illegal escape in diff_fromDelta: ' + param);
        }
        break;
      case '-':
        // Fall through.
      case '=':
        var n = parseInt(param, 10);
        if (isNaN(n) || n < 0) {
          throw new Error('Invalid number in diff_fromDelta: ' + param);
        }
        var text = text1.substring(pointer, pointer += n);
        if (tokens[x].charAt(0) == '=') {
          diffs[diffsLength++] = [DIFF_EQUAL, text];
        } else {
          diffs[diffsLength++] = [DIFF_DELETE, text];
        }
        break;
      default:
        // Blank tokens are ok (from a trailing \t).
        // Anything else is an error.
        if (tokens[x]) {
          throw new Error('Invalid diff operation in diff_fromDelta: ' +
                          tokens[x]);
        }
    }
  }
  if (pointer != text1.length) {
    throw new Error('Delta length (' + pointer +
        ') does not equal source text length (' + text1.length + ').');
  }
  return diffs;
};


//  MATCH FUNCTIONS


/**
 * Locate the best instance of 'pattern' in 'text' near 'loc'.
 * @param {string} text The text to search.
 * @param {string} pattern The pattern to search for.
 * @param {number} loc The location to search around.
 * @return {number} Best match index or -1.
 */
diff_match_patch.prototype.match_main = function(text, pattern, loc) {
  // Check for null inputs.
  if (text == null || pattern == null || loc == null) {
    throw new Error('Null input. (match_main)');
  }

  loc = Math.max(0, Math.min(loc, text.length));
  if (text == pattern) {
    // Shortcut (potentially not guaranteed by the algorithm)
    return 0;
  } else if (!text.length) {
    // Nothing to match.
    return -1;
  } else if (text.substring(loc, loc + pattern.length) == pattern) {
    // Perfect match at the perfect spot!  (Includes case of null pattern)
    return loc;
  } else {
    // Do a fuzzy compare.
    return this.match_bitap_(text, pattern, loc);
  }
};


/**
 * Locate the best instance of 'pattern' in 'text' near 'loc' using the
 * Bitap algorithm.
 * @param {string} text The text to search.
 * @param {string} pattern The pattern to search for.
 * @param {number} loc The location to search around.
 * @return {number} Best match index or -1.
 * @private
 */
diff_match_patch.prototype.match_bitap_ = function(text, pattern, loc) {
  if (pattern.length > this.Match_MaxBits) {
    throw new Error('Pattern too long for this browser.');
  }

  // Initialise the alphabet.
  var s = this.match_alphabet_(pattern);

  var dmp = this;  // 'this' becomes 'window' in a closure.

  /**
   * Compute and return the score for a match with e errors and x location.
   * Accesses loc and pattern through being a closure.
   * @param {number} e Number of errors in match.
   * @param {number} x Location of match.
   * @return {number} Overall score for match (0.0 = good, 1.0 = bad).
   * @private
   */
  function match_bitapScore_(e, x) {
    var accuracy = e / pattern.length;
    var proximity = Math.abs(loc - x);
    if (!dmp.Match_Distance) {
      // Dodge divide by zero error.
      return proximity ? 1.0 : accuracy;
    }
    return accuracy + (proximity / dmp.Match_Distance);
  }

  // Highest score beyond which we give up.
  var score_threshold = this.Match_Threshold;
  // Is there a nearby exact match? (speedup)
  var best_loc = text.indexOf(pattern, loc);
  if (best_loc != -1) {
    score_threshold = Math.min(match_bitapScore_(0, best_loc), score_threshold);
    // What about in the other direction? (speedup)
    best_loc = text.lastIndexOf(pattern, loc + pattern.length);
    if (best_loc != -1) {
      score_threshold =
          Math.min(match_bitapScore_(0, best_loc), score_threshold);
    }
  }

  // Initialise the bit arrays.
  var matchmask = 1 << (pattern.length - 1);
  best_loc = -1;

  var bin_min, bin_mid;
  var bin_max = pattern.length + text.length;
  var last_rd;
  for (var d = 0; d < pattern.length; d++) {
    // Scan for the best match; each iteration allows for one more error.
    // Run a binary search to determine how far from 'loc' we can stray at this
    // error level.
    bin_min = 0;
    bin_mid = bin_max;
    while (bin_min < bin_mid) {
      if (match_bitapScore_(d, loc + bin_mid) <= score_threshold) {
        bin_min = bin_mid;
      } else {
        bin_max = bin_mid;
      }
      bin_mid = Math.floor((bin_max - bin_min) / 2 + bin_min);
    }
    // Use the result from this iteration as the maximum for the next.
    bin_max = bin_mid;
    var start = Math.max(1, loc - bin_mid + 1);
    var finish = Math.min(loc + bin_mid, text.length) + pattern.length;

    var rd = Array(finish + 2);
    rd[finish + 1] = (1 << d) - 1;
    for (var j = finish; j >= start; j--) {
      // The alphabet (s) is a sparse hash, so the following line generates
      // warnings.
      var charMatch = s[text.charAt(j - 1)];
      if (d === 0) {  // First pass: exact match.
        rd[j] = ((rd[j + 1] << 1) | 1) & charMatch;
      } else {  // Subsequent passes: fuzzy match.
        rd[j] = ((rd[j + 1] << 1) | 1) & charMatch |
                (((last_rd[j + 1] | last_rd[j]) << 1) | 1) |
                last_rd[j + 1];
      }
      if (rd[j] & matchmask) {
        var score = match_bitapScore_(d, j - 1);
        // This match will almost certainly be better than any existing match.
        // But check anyway.
        if (score <= score_threshold) {
          // Told you so.
          score_threshold = score;
          best_loc = j - 1;
          if (best_loc > loc) {
            // When passing loc, don't exceed our current distance from loc.
            start = Math.max(1, 2 * loc - best_loc);
          } else {
            // Already passed loc, downhill from here on in.
            break;
          }
        }
      }
    }
    // No hope for a (better) match at greater error levels.
    if (match_bitapScore_(d + 1, loc) > score_threshold) {
      break;
    }
    last_rd = rd;
  }
  return best_loc;
};


/**
 * Initialise the alphabet for the Bitap algorithm.
 * @param {string} pattern The text to encode.
 * @return {!Object} Hash of character locations.
 * @private
 */
diff_match_patch.prototype.match_alphabet_ = function(pattern) {
  var s = {};
  for (var i = 0; i < pattern.length; i++) {
    s[pattern.charAt(i)] = 0;
  }
  for (var i = 0; i < pattern.length; i++) {
    s[pattern.charAt(i)] |= 1 << (pattern.length - i - 1);
  }
  return s;
};


//  PATCH FUNCTIONS


/**
 * Increase the context until it is unique,
 * but don't let the pattern expand beyond Match_MaxBits.
 * @param {!diff_match_patch.patch_obj} patch The patch to grow.
 * @param {string} text Source text.
 * @private
 */
diff_match_patch.prototype.patch_addContext_ = function(patch, text) {
  if (text.length == 0) {
    return;
  }
  var pattern = text.substring(patch.start2, patch.start2 + patch.length1);
  var padding = 0;

  // Look for the first and last matches of pattern in text.  If two different
  // matches are found, increase the pattern length.
  while (text.indexOf(pattern) != text.lastIndexOf(pattern) &&
         pattern.length < this.Match_MaxBits - this.Patch_Margin -
         this.Patch_Margin) {
    padding += this.Patch_Margin;
    pattern = text.substring(patch.start2 - padding,
                             patch.start2 + patch.length1 + padding);
  }
  // Add one chunk for good luck.
  padding += this.Patch_Margin;

  // Add the prefix.
  var prefix = text.substring(patch.start2 - padding, patch.start2);
  if (prefix) {
    patch.diffs.unshift([DIFF_EQUAL, prefix]);
  }
  // Add the suffix.
  var suffix = text.substring(patch.start2 + patch.length1,
                              patch.start2 + patch.length1 + padding);
  if (suffix) {
    patch.diffs.push([DIFF_EQUAL, suffix]);
  }

  // Roll back the start points.
  patch.start1 -= prefix.length;
  patch.start2 -= prefix.length;
  // Extend the lengths.
  patch.length1 += prefix.length + suffix.length;
  patch.length2 += prefix.length + suffix.length;
};


/**
 * Compute a list of patches to turn text1 into text2.
 * Use diffs if provided, otherwise compute it ourselves.
 * There are four ways to call this function, depending on what data is
 * available to the caller:
 * Method 1:
 * a = text1, b = text2
 * Method 2:
 * a = diffs
 * Method 3 (optimal):
 * a = text1, b = diffs
 * Method 4 (deprecated, use method 3):
 * a = text1, b = text2, c = diffs
 *
 * @param {string|!Array.<!diff_match_patch.Diff>} a text1 (methods 1,3,4) or
 * Array of diff tuples for text1 to text2 (method 2).
 * @param {string|!Array.<!diff_match_patch.Diff>} opt_b text2 (methods 1,4) or
 * Array of diff tuples for text1 to text2 (method 3) or undefined (method 2).
 * @param {string|!Array.<!diff_match_patch.Diff>} opt_c Array of diff tuples
 * for text1 to text2 (method 4) or undefined (methods 1,2,3).
 * @return {!Array.<!diff_match_patch.patch_obj>} Array of patch objects.
 */
diff_match_patch.prototype.patch_make = function(a, opt_b, opt_c) {
  var text1, diffs;
  if (typeof a == 'string' && typeof opt_b == 'string' &&
      typeof opt_c == 'undefined') {
    // Method 1: text1, text2
    // Compute diffs from text1 and text2.
    text1 = /** @type {string} */(a);
    diffs = this.diff_main(text1, /** @type {string} */(opt_b), true);
    if (diffs.length > 2) {
      this.diff_cleanupSemantic(diffs);
      this.diff_cleanupEfficiency(diffs);
    }
  } else if (a && typeof a == 'object' && typeof opt_b == 'undefined' &&
      typeof opt_c == 'undefined') {
    // Method 2: diffs
    // Compute text1 from diffs.
    diffs = /** @type {!Array.<!diff_match_patch.Diff>} */(a);
    text1 = this.diff_text1(diffs);
  } else if (typeof a == 'string' && opt_b && typeof opt_b == 'object' &&
      typeof opt_c == 'undefined') {
    // Method 3: text1, diffs
    text1 = /** @type {string} */(a);
    diffs = /** @type {!Array.<!diff_match_patch.Diff>} */(opt_b);
  } else if (typeof a == 'string' && typeof opt_b == 'string' &&
      opt_c && typeof opt_c == 'object') {
    // Method 4: text1, text2, diffs
    // text2 is not used.
    text1 = /** @type {string} */(a);
    diffs = /** @type {!Array.<!diff_match_patch.Diff>} */(opt_c);
  } else {
    throw new Error('Unknown call format to patch_make.');
  }

  if (diffs.length === 0) {
    return [];  // Get rid of the null case.
  }
  var patches = [];
  var patch = new diff_match_patch.patch_obj();
  var patchDiffLength = 0;  // Keeping our own length var is faster in JS.
  var char_count1 = 0;  // Number of characters into the text1 string.
  var char_count2 = 0;  // Number of characters into the text2 string.
  // Start with text1 (prepatch_text) and apply the diffs until we arrive at
  // text2 (postpatch_text).  We recreate the patches one by one to determine
  // context info.
  var prepatch_text = text1;
  var postpatch_text = text1;
  for (var x = 0; x < diffs.length; x++) {
    var diff_type = diffs[x][0];
    var diff_text = diffs[x][1];

    if (!patchDiffLength && diff_type !== DIFF_EQUAL) {
      // A new patch starts here.
      patch.start1 = char_count1;
      patch.start2 = char_count2;
    }

    switch (diff_type) {
      case DIFF_INSERT:
        patch.diffs[patchDiffLength++] = diffs[x];
        patch.length2 += diff_text.length;
        postpatch_text = postpatch_text.substring(0, char_count2) + diff_text +
                         postpatch_text.substring(char_count2);
        break;
      case DIFF_DELETE:
        patch.length1 += diff_text.length;
        patch.diffs[patchDiffLength++] = diffs[x];
        postpatch_text = postpatch_text.substring(0, char_count2) +
                         postpatch_text.substring(char_count2 +
                             diff_text.length);
        break;
      case DIFF_EQUAL:
        if (diff_text.length <= 2 * this.Patch_Margin &&
            patchDiffLength && diffs.length != x + 1) {
          // Small equality inside a patch.
          patch.diffs[patchDiffLength++] = diffs[x];
          patch.length1 += diff_text.length;
          patch.length2 += diff_text.length;
        } else if (diff_text.length >= 2 * this.Patch_Margin) {
          // Time for a new patch.
          if (patchDiffLength) {
            this.patch_addContext_(patch, prepatch_text);
            patches.push(patch);
            patch = new diff_match_patch.patch_obj();
            patchDiffLength = 0;
            // Unlike Unidiff, our patch lists have a rolling context.
            // http://code.google.com/p/google-diff-match-patch/wiki/Unidiff
            // Update prepatch text & pos to reflect the application of the
            // just completed patch.
            prepatch_text = postpatch_text;
            char_count1 = char_count2;
          }
        }
        break;
    }

    // Update the current character count.
    if (diff_type !== DIFF_INSERT) {
      char_count1 += diff_text.length;
    }
    if (diff_type !== DIFF_DELETE) {
      char_count2 += diff_text.length;
    }
  }
  // Pick up the leftover patch if not empty.
  if (patchDiffLength) {
    this.patch_addContext_(patch, prepatch_text);
    patches.push(patch);
  }

  return patches;
};


/**
 * Given an array of patches, return another array that is identical.
 * @param {!Array.<!diff_match_patch.patch_obj>} patches Array of patch objects.
 * @return {!Array.<!diff_match_patch.patch_obj>} Array of patch objects.
 */
diff_match_patch.prototype.patch_deepCopy = function(patches) {
  // Making deep copies is hard in JavaScript.
  var patchesCopy = [];
  for (var x = 0; x < patches.length; x++) {
    var patch = patches[x];
    var patchCopy = new diff_match_patch.patch_obj();
    patchCopy.diffs = [];
    for (var y = 0; y < patch.diffs.length; y++) {
      patchCopy.diffs[y] = patch.diffs[y].slice();
    }
    patchCopy.start1 = patch.start1;
    patchCopy.start2 = patch.start2;
    patchCopy.length1 = patch.length1;
    patchCopy.length2 = patch.length2;
    patchesCopy[x] = patchCopy;
  }
  return patchesCopy;
};


/**
 * Merge a set of patches onto the text.  Return a patched text, as well
 * as a list of true/false values indicating which patches were applied.
 * @param {!Array.<!diff_match_patch.patch_obj>} patches Array of patch objects.
 * @param {string} text Old text.
 * @return {!Array.<string|!Array.<boolean>>} Two element Array, containing the
 *      new text and an array of boolean values.
 */
diff_match_patch.prototype.patch_apply = function(patches, text) {
  if (patches.length == 0) {
    return [text, []];
  }

  // Deep copy the patches so that no changes are made to originals.
  patches = this.patch_deepCopy(patches);

  var nullPadding = this.patch_addPadding(patches);
  text = nullPadding + text + nullPadding;

  this.patch_splitMax(patches);
  // delta keeps track of the offset between the expected and actual location
  // of the previous patch.  If there are patches expected at positions 10 and
  // 20, but the first patch was found at 12, delta is 2 and the second patch
  // has an effective expected position of 22.
  var delta = 0;
  var results = [];
  for (var x = 0; x < patches.length; x++) {
    var expected_loc = patches[x].start2 + delta;
    var text1 = this.diff_text1(patches[x].diffs);
    var start_loc;
    var end_loc = -1;
    if (text1.length > this.Match_MaxBits) {
      // patch_splitMax will only provide an oversized pattern in the case of
      // a monster delete.
      start_loc = this.match_main(text, text1.substring(0, this.Match_MaxBits),
                                  expected_loc);
      if (start_loc != -1) {
        end_loc = this.match_main(text,
            text1.substring(text1.length - this.Match_MaxBits),
            expected_loc + text1.length - this.Match_MaxBits);
        if (end_loc == -1 || start_loc >= end_loc) {
          // Can't find valid trailing context.  Drop this patch.
          start_loc = -1;
        }
      }
    } else {
      start_loc = this.match_main(text, text1, expected_loc);
    }
    if (start_loc == -1) {
      // No match found.  :(
      results[x] = false;
      // Subtract the delta for this failed patch from subsequent patches.
      delta -= patches[x].length2 - patches[x].length1;
    } else {
      // Found a match.  :)
      results[x] = true;
      delta = start_loc - expected_loc;
      var text2;
      if (end_loc == -1) {
        text2 = text.substring(start_loc, start_loc + text1.length);
      } else {
        text2 = text.substring(start_loc, end_loc + this.Match_MaxBits);
      }
      if (text1 == text2) {
        // Perfect match, just shove the replacement text in.
        text = text.substring(0, start_loc) +
               this.diff_text2(patches[x].diffs) +
               text.substring(start_loc + text1.length);
      } else {
        // Imperfect match.  Run a diff to get a framework of equivalent
        // indices.
        var diffs = this.diff_main(text1, text2, false);
        if (text1.length > this.Match_MaxBits &&
            this.diff_levenshtein(diffs) / text1.length >
            this.Patch_DeleteThreshold) {
          // The end points match, but the content is unacceptably bad.
          results[x] = false;
        } else {
          this.diff_cleanupSemanticLossless(diffs);
          var index1 = 0;
          var index2;
          for (var y = 0; y < patches[x].diffs.length; y++) {
            var mod = patches[x].diffs[y];
            if (mod[0] !== DIFF_EQUAL) {
              index2 = this.diff_xIndex(diffs, index1);
            }
            if (mod[0] === DIFF_INSERT) {  // Insertion
              text = text.substring(0, start_loc + index2) + mod[1] +
                     text.substring(start_loc + index2);
            } else if (mod[0] === DIFF_DELETE) {  // Deletion
              text = text.substring(0, start_loc + index2) +
                     text.substring(start_loc + this.diff_xIndex(diffs,
                         index1 + mod[1].length));
            }
            if (mod[0] !== DIFF_DELETE) {
              index1 += mod[1].length;
            }
          }
        }
      }
    }
  }
  // Strip the padding off.
  text = text.substring(nullPadding.length, text.length - nullPadding.length);
  return [text, results];
};


/**
 * Add some padding on text start and end so that edges can match something.
 * Intended to be called only from within patch_apply.
 * @param {!Array.<!diff_match_patch.patch_obj>} patches Array of patch objects.
 * @return {string} The padding string added to each side.
 */
diff_match_patch.prototype.patch_addPadding = function(patches) {
  var paddingLength = this.Patch_Margin;
  var nullPadding = '';
  for (var x = 1; x <= paddingLength; x++) {
    nullPadding += String.fromCharCode(x);
  }

  // Bump all the patches forward.
  for (var x = 0; x < patches.length; x++) {
    patches[x].start1 += paddingLength;
    patches[x].start2 += paddingLength;
  }

  // Add some padding on start of first diff.
  var patch = patches[0];
  var diffs = patch.diffs;
  if (diffs.length == 0 || diffs[0][0] != DIFF_EQUAL) {
    // Add nullPadding equality.
    diffs.unshift([DIFF_EQUAL, nullPadding]);
    patch.start1 -= paddingLength;  // Should be 0.
    patch.start2 -= paddingLength;  // Should be 0.
    patch.length1 += paddingLength;
    patch.length2 += paddingLength;
  } else if (paddingLength > diffs[0][1].length) {
    // Grow first equality.
    var extraLength = paddingLength - diffs[0][1].length;
    diffs[0][1] = nullPadding.substring(diffs[0][1].length) + diffs[0][1];
    patch.start1 -= extraLength;
    patch.start2 -= extraLength;
    patch.length1 += extraLength;
    patch.length2 += extraLength;
  }

  // Add some padding on end of last diff.
  patch = patches[patches.length - 1];
  diffs = patch.diffs;
  if (diffs.length == 0 || diffs[diffs.length - 1][0] != DIFF_EQUAL) {
    // Add nullPadding equality.
    diffs.push([DIFF_EQUAL, nullPadding]);
    patch.length1 += paddingLength;
    patch.length2 += paddingLength;
  } else if (paddingLength > diffs[diffs.length - 1][1].length) {
    // Grow last equality.
    var extraLength = paddingLength - diffs[diffs.length - 1][1].length;
    diffs[diffs.length - 1][1] += nullPadding.substring(0, extraLength);
    patch.length1 += extraLength;
    patch.length2 += extraLength;
  }

  return nullPadding;
};


/**
 * Look through the patches and break up any which are longer than the maximum
 * limit of the match algorithm.
 * Intended to be called only from within patch_apply.
 * @param {!Array.<!diff_match_patch.patch_obj>} patches Array of patch objects.
 */
diff_match_patch.prototype.patch_splitMax = function(patches) {
  var patch_size = this.Match_MaxBits;
  for (var x = 0; x < patches.length; x++) {
    if (patches[x].length1 > patch_size) {
      var bigpatch = patches[x];
      // Remove the big old patch.
      patches.splice(x--, 1);
      var start1 = bigpatch.start1;
      var start2 = bigpatch.start2;
      var precontext = '';
      while (bigpatch.diffs.length !== 0) {
        // Create one of several smaller patches.
        var patch = new diff_match_patch.patch_obj();
        var empty = true;
        patch.start1 = start1 - precontext.length;
        patch.start2 = start2 - precontext.length;
        if (precontext !== '') {
          patch.length1 = patch.length2 = precontext.length;
          patch.diffs.push([DIFF_EQUAL, precontext]);
        }
        while (bigpatch.diffs.length !== 0 &&
               patch.length1 < patch_size - this.Patch_Margin) {
          var diff_type = bigpatch.diffs[0][0];
          var diff_text = bigpatch.diffs[0][1];
          if (diff_type === DIFF_INSERT) {
            // Insertions are harmless.
            patch.length2 += diff_text.length;
            start2 += diff_text.length;
            patch.diffs.push(bigpatch.diffs.shift());
            empty = false;
          } else if (diff_type === DIFF_DELETE && patch.diffs.length == 1 &&
                     patch.diffs[0][0] == DIFF_EQUAL &&
                     diff_text.length > 2 * patch_size) {
            // This is a large deletion.  Let it pass in one chunk.
            patch.length1 += diff_text.length;
            start1 += diff_text.length;
            empty = false;
            patch.diffs.push([diff_type, diff_text]);
            bigpatch.diffs.shift();
          } else {
            // Deletion or equality.  Only take as much as we can stomach.
            diff_text = diff_text.substring(0,
                patch_size - patch.length1 - this.Patch_Margin);
            patch.length1 += diff_text.length;
            start1 += diff_text.length;
            if (diff_type === DIFF_EQUAL) {
              patch.length2 += diff_text.length;
              start2 += diff_text.length;
            } else {
              empty = false;
            }
            patch.diffs.push([diff_type, diff_text]);
            if (diff_text == bigpatch.diffs[0][1]) {
              bigpatch.diffs.shift();
            } else {
              bigpatch.diffs[0][1] =
                  bigpatch.diffs[0][1].substring(diff_text.length);
            }
          }
        }
        // Compute the head context for the next patch.
        precontext = this.diff_text2(patch.diffs);
        precontext =
            precontext.substring(precontext.length - this.Patch_Margin);
        // Append the end context for this patch.
        var postcontext = this.diff_text1(bigpatch.diffs)
                              .substring(0, this.Patch_Margin);
        if (postcontext !== '') {
          patch.length1 += postcontext.length;
          patch.length2 += postcontext.length;
          if (patch.diffs.length !== 0 &&
              patch.diffs[patch.diffs.length - 1][0] === DIFF_EQUAL) {
            patch.diffs[patch.diffs.length - 1][1] += postcontext;
          } else {
            patch.diffs.push([DIFF_EQUAL, postcontext]);
          }
        }
        if (!empty) {
          patches.splice(++x, 0, patch);
        }
      }
    }
  }
};


/**
 * Take a list of patches and return a textual representation.
 * @param {!Array.<!diff_match_patch.patch_obj>} patches Array of patch objects.
 * @return {string} Text representation of patches.
 */
diff_match_patch.prototype.patch_toText = function(patches) {
  var text = [];
  for (var x = 0; x < patches.length; x++) {
    text[x] = patches[x];
  }
  return text.join('');
};


/**
 * Parse a textual representation of patches and return a list of patch objects.
 * @param {string} textline Text representation of patches.
 * @return {!Array.<!diff_match_patch.patch_obj>} Array of patch objects.
 * @throws {!Error} If invalid input.
 */
diff_match_patch.prototype.patch_fromText = function(textline) {
  var patches = [];
  if (!textline) {
    return patches;
  }
  var text = textline.split('\n');
  var textPointer = 0;
  var patchHeader = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@$/;
  while (textPointer < text.length) {
    var m = text[textPointer].match(patchHeader);
    if (!m) {
      throw new Error('Invalid patch string: ' + text[textPointer]);
    }
    var patch = new diff_match_patch.patch_obj();
    patches.push(patch);
    patch.start1 = parseInt(m[1], 10);
    if (m[2] === '') {
      patch.start1--;
      patch.length1 = 1;
    } else if (m[2] == '0') {
      patch.length1 = 0;
    } else {
      patch.start1--;
      patch.length1 = parseInt(m[2], 10);
    }

    patch.start2 = parseInt(m[3], 10);
    if (m[4] === '') {
      patch.start2--;
      patch.length2 = 1;
    } else if (m[4] == '0') {
      patch.length2 = 0;
    } else {
      patch.start2--;
      patch.length2 = parseInt(m[4], 10);
    }
    textPointer++;

    while (textPointer < text.length) {
      var sign = text[textPointer].charAt(0);
      try {
        var line = decodeURI(text[textPointer].substring(1));
      } catch (ex) {
        // Malformed URI sequence.
        throw new Error('Illegal escape in patch_fromText: ' + line);
      }
      if (sign == '-') {
        // Deletion.
        patch.diffs.push([DIFF_DELETE, line]);
      } else if (sign == '+') {
        // Insertion.
        patch.diffs.push([DIFF_INSERT, line]);
      } else if (sign == ' ') {
        // Minor equality.
        patch.diffs.push([DIFF_EQUAL, line]);
      } else if (sign == '@') {
        // Start of next patch.
        break;
      } else if (sign === '') {
        // Blank line?  Whatever.
      } else {
        // WTF?
        throw new Error('Invalid patch mode "' + sign + '" in: ' + line);
      }
      textPointer++;
    }
  }
  return patches;
};


/**
 * Class representing one patch operation.
 * @constructor
 */
diff_match_patch.patch_obj = function() {
  /** @type {!Array.<!diff_match_patch.Diff>} */
  this.diffs = [];
  /** @type {?number} */
  this.start1 = null;
  /** @type {?number} */
  this.start2 = null;
  /** @type {number} */
  this.length1 = 0;
  /** @type {number} */
  this.length2 = 0;
};


/**
 * Emmulate GNU diff's format.
 * Header: @@ -382,8 +481,9 @@
 * Indicies are printed as 1-based, not 0-based.
 * @return {string} The GNU diff string.
 */
diff_match_patch.patch_obj.prototype.toString = function() {
  var coords1, coords2;
  if (this.length1 === 0) {
    coords1 = this.start1 + ',0';
  } else if (this.length1 == 1) {
    coords1 = this.start1 + 1;
  } else {
    coords1 = (this.start1 + 1) + ',' + this.length1;
  }
  if (this.length2 === 0) {
    coords2 = this.start2 + ',0';
  } else if (this.length2 == 1) {
    coords2 = this.start2 + 1;
  } else {
    coords2 = (this.start2 + 1) + ',' + this.length2;
  }
  var text = ['@@ -' + coords1 + ' +' + coords2 + ' @@\n'];
  var op;
  // Escape the body of the patch with %xx notation.
  for (var x = 0; x < this.diffs.length; x++) {
    switch (this.diffs[x][0]) {
      case DIFF_INSERT:
        op = '+';
        break;
      case DIFF_DELETE:
        op = '-';
        break;
      case DIFF_EQUAL:
        op = ' ';
        break;
    }
    text[x + 1] = op + encodeURI(this.diffs[x][1]) + '\n';
  }
  return text.join('').replace(/%20/g, ' ');
};


// Export these global variables so that they survive Google's JS compiler.
// In a browser, 'this' will be 'window'.
// Users of node.js should 'require' the uncompressed version since Google's
// JS compiler may break the following exports for non-browser environments.
this['diff_match_patch'] = diff_match_patch;
this['DIFF_DELETE'] = DIFF_DELETE;
this['DIFF_INSERT'] = DIFF_INSERT;
this['DIFF_EQUAL'] = DIFF_EQUAL;
/** Socket.IO 0.6.2 - Built with build.js */
/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

var io = this.io = {
	version: '0.6.2',
	
	setPath: function(path){
		if (window.console && console.error) console.error('io.setPath will be removed. Please set the variable WEB_SOCKET_SWF_LOCATION pointing to WebSocketMain.swf');
		this.path = /\/$/.test(path) ? path : path + '/';
    WEB_SOCKET_SWF_LOCATION = path + 'lib/vendor/web-socket-js/WebSocketMain.swf';
	}
};

if ('jQuery' in this) jQuery.io = this.io;

if (typeof window != 'undefined'){
  // WEB_SOCKET_SWF_LOCATION = (document.location.protocol == 'https:' ? 'https:' : 'http:') + '//cdn.socket.io/' + this.io.version + '/WebSocketMain.swf';
  if (typeof WEB_SOCKET_SWF_LOCATION === 'undefined')
    WEB_SOCKET_SWF_LOCATION = '/socket.io/lib/vendor/web-socket-js/WebSocketMain.swf';
}

/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;

	var _pageLoaded = false;

	io.util = {

		ios: false,

		load: function(fn){
			if (/loaded|complete/.test(document.readyState) || _pageLoaded) return fn();
			if ('attachEvent' in window){
				window.attachEvent('onload', fn);
			} else {
				window.addEventListener('load', fn, false);
			}
		},

		inherit: function(ctor, superCtor){
			// no support for `instanceof` for now
			for (var i in superCtor.prototype){
				ctor.prototype[i] = superCtor.prototype[i];
			}
		},

		indexOf: function(arr, item, from){
			for (var l = arr.length, i = (from < 0) ? Math.max(0, l + from) : from || 0; i < l; i++){
				if (arr[i] === item) return i;
			}
			return -1;
		},

		isArray: function(obj){
			return Object.prototype.toString.call(obj) === '[object Array]';
		},
		
    merge: function(target, additional){
      for (var i in additional)
        if (additional.hasOwnProperty(i))
          target[i] = additional[i];
    }

	};

	io.util.ios = /iphone|ipad/i.test(navigator.userAgent);
	io.util.android = /android/i.test(navigator.userAgent);
	io.util.opera = /opera/i.test(navigator.userAgent);

	io.util.load(function(){
		_pageLoaded = true;
	});

})();

/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

// abstract

(function(){
	var io = this.io;
	
	var frame = '~m~',
	
	stringify = function(message){
		if (Object.prototype.toString.call(message) == '[object Object]'){
			if (!('JSON' in window)){
				if ('console' in window && console.error) console.error('Trying to encode as JSON, but JSON.stringify is missing.');
				return '{ "$error": "Invalid message" }';
			}
			return '~j~' + JSON.stringify(message);
		} else {
			return String(message);
		}
	};
	
	Transport = io.Transport = function(base, options){
		this.base = base;
		this.options = {
			timeout: 15000 // based on heartbeat interval default
		};
		io.util.merge(this.options, options);
	};

	Transport.prototype.send = function(){
		throw new Error('Missing send() implementation');
	};

	Transport.prototype.connect = function(){
		throw new Error('Missing connect() implementation');
	};

	Transport.prototype.disconnect = function(){
		throw new Error('Missing disconnect() implementation');
	};
	
	Transport.prototype._encode = function(messages){
		var ret = '', message,
				messages = io.util.isArray(messages) ? messages : [messages];
		for (var i = 0, l = messages.length; i < l; i++){
			message = messages[i] === null || messages[i] === undefined ? '' : stringify(messages[i]);
			ret += frame + message.length + frame + message;
		}
		return ret;
	};
	
	Transport.prototype._decode = function(data){
		var messages = [], number, n;
		do {
			if (data.substr(0, 3) !== frame) return messages;
			data = data.substr(3);
			number = '', n = '';
			for (var i = 0, l = data.length; i < l; i++){
				n = Number(data.substr(i, 1));
				if (data.substr(i, 1) == n){
					number += n;
				} else {	
					data = data.substr(number.length + frame.length);
					number = Number(number);
					break;
				} 
			}
			messages.push(data.substr(0, number)); // here
			data = data.substr(number);
		} while(data !== '');
		return messages;
	};
	
	Transport.prototype._onData = function(data){
		this._setTimeout();
		var msgs = this._decode(data);
		if (msgs && msgs.length){
			for (var i = 0, l = msgs.length; i < l; i++){
				this._onMessage(msgs[i]);
			}
		}
	};
	
	Transport.prototype._setTimeout = function(){
		var self = this;
		if (this._timeout) clearTimeout(this._timeout);
		this._timeout = setTimeout(function(){
			self._onTimeout();
		}, this.options.timeout);
	};
	
	Transport.prototype._onTimeout = function(){
		this._onDisconnect();
	};
	
	Transport.prototype._onMessage = function(message){
		if (!this.sessionid){
			this.sessionid = message;
			this._onConnect();
		} else if (message.substr(0, 3) == '~h~'){
			this._onHeartbeat(message.substr(3));
		} else if (message.substr(0, 3) == '~j~'){
			this.base._onMessage(JSON.parse(message.substr(3)));
		} else {
			this.base._onMessage(message);
		}
	},
	
	Transport.prototype._onHeartbeat = function(heartbeat){
		this.send('~h~' + heartbeat); // echo
	};
	
	Transport.prototype._onConnect = function(){
		this.connected = true;
		this.connecting = false;
		this.base._onConnect();
		this._setTimeout();
	};

	Transport.prototype._onDisconnect = function(){
		this.connecting = false;
		this.connected = false;
		this.sessionid = null;
		this.base._onDisconnect();
	};

	Transport.prototype._prepareUrl = function(){
		return (this.base.options.secure ? 'https' : 'http') 
			+ '://' + this.base.host 
			+ ':' + this.base.options.port
			+ '/' + this.base.options.resource
			+ '/' + this.type
			+ (this.sessionid ? ('/' + this.sessionid) : '/');
	};

    io.Transport = Transport;
})();
/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
	var empty = new Function,
	    
	XMLHttpRequestCORS = (function(){
		if (!('XMLHttpRequest' in window)) return false;
		// CORS feature detection
		var a = new XMLHttpRequest();
		return a.withCredentials != undefined;
	})(),
	
	request = function(xdomain){
		if ('XDomainRequest' in window && xdomain) return new XDomainRequest();
		if ('XMLHttpRequest' in window && (!xdomain || XMLHttpRequestCORS)) return new XMLHttpRequest();
		if (!xdomain){
			try {
				var a = new ActiveXObject('MSXML2.XMLHTTP');
				return a;
			} catch(e){}
		
			try {
				var b = new ActiveXObject('Microsoft.XMLHTTP');
				return b;
			} catch(e){}
		}
		return false;
	},
	
	XHR = io.Transport['XHR'] = function(){
		io.Transport.apply(this, arguments);
		this._sendBuffer = [];
	};
	
	io.util.inherit(XHR, io.Transport);
	
	XHR.prototype.connect = function(){
		this._get();
		return this;
	};
	
	XHR.prototype._checkSend = function(){
		if (!this._posting && this._sendBuffer.length){
			var encoded = this._encode(this._sendBuffer);
			this._sendBuffer = [];
			this._send(encoded);
		}
	};
	
	XHR.prototype.send = function(data){
		if (io.util.isArray(data)){
			this._sendBuffer.push.apply(this._sendBuffer, data);
		} else {
			this._sendBuffer.push(data);
		}
		this._checkSend();
		return this;
	};
	
	XHR.prototype._send = function(data){
		var self = this;
		this._posting = true;
		this._sendXhr = this._request('send', 'POST');
		this._sendXhr.onreadystatechange = function(){
			var status;
			if (self._sendXhr.readyState == 4){
				self._sendXhr.onreadystatechange = empty;
				try { status = self._sendXhr.status; } catch(e){}
				self._posting = false;
				if (status == 200){
					self._checkSend();
				} else {
					self._onDisconnect();
				}
			}
		};
		this._sendXhr.send('data=' + encodeURIComponent(data));
	};
	
	XHR.prototype.disconnect = function(){
		// send disconnection signal
		this._onDisconnect();
		return this;
	};
	
	XHR.prototype._onDisconnect = function(){
		if (this._xhr){
			this._xhr.onreadystatechange = empty;
      try {
        this._xhr.abort();
      } catch(e){}
			this._xhr = null;
		}
		if (this._sendXhr){
      this._sendXhr.onreadystatechange = empty;
      try {
        this._sendXhr.abort();
      } catch(e){}
			this._sendXhr = null;
		}
		this._sendBuffer = [];
		io.Transport.prototype._onDisconnect.call(this);
	};
	
	XHR.prototype._request = function(url, method, multipart){
		var req = request(this.base._isXDomain());
		if (multipart) req.multipart = true;
		req.open(method || 'GET', this._prepareUrl() + (url ? '/' + url : ''));
        if ('withCredentials' in req) {
            req.withCredentials = "true";
        }
		if (method == 'POST' && 'setRequestHeader' in req){
			req.setRequestHeader('Content-type', 'application/x-www-form-urlencoded; charset=utf-8');
		}
		return req;
	};
	
	XHR.check = function(xdomain){
		try {
			if (request(xdomain)) return true;
		} catch(e){}
		return false;
	};
	
	XHR.xdomainCheck = function(){
		return XHR.check(true);
	};
	
	XHR.request = request;
	
})();

/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
    WebSocket = window['WebSocket'];

	var WS = io.Transport['websocket'] = function(){
		io.Transport.apply(this, arguments);
	};
	
	io.util.inherit(WS, io.Transport);
	
	WS.prototype.type = 'websocket';
	
	WS.prototype.connect = function(){
		var self = this;
		this.socket = new WebSocket(this._prepareUrl());
		this.socket.onmessage = function(ev){ self._onData(ev.data); };
		this.socket.onclose = function(ev){ self._onClose(); };
    this.socket.onerror = function(e){ self._onError(e); };
		return this;
	};
	
	WS.prototype.send = function(data){
		if (this.socket) this.socket.send(this._encode(data));
		return this;
	};
	
	WS.prototype.disconnect = function(){
		if (this.socket) this.socket.close();
		return this;
	};
	
	WS.prototype._onClose = function(){
		this._onDisconnect();
		return this;
	};

  WS.prototype._onError = function(e){
    this.base.emit('error', [e]);
  };
	
	WS.prototype._prepareUrl = function(){
		return (this.base.options.secure ? 'wss' : 'ws') 
		+ '://' + this.base.host 
		+ ':' + this.base.options.port
		+ '/' + this.base.options.resource
		+ '/' + this.type
		+ (this.sessionid ? ('/' + this.sessionid) : '');
	};
	
	WS.check = function(){
        if ("MozWebSocket" in window) {
            window["WebSocket"] = window["MozWebSocket"];
            WebSocket = window["MozWebSocket"];
        }
		// we make sure WebSocket is not confounded with a previously loaded flash WebSocket
		return 'WebSocket' in window && WebSocket.prototype && ( WebSocket.prototype.send && !!WebSocket.prototype.send.toString().match(/native/i)) && typeof WebSocket !== "undefined";
	};

	WS.xdomainCheck = function(){
		return true;
	};
	
})();

/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
	var Flashsocket = io.Transport['flashsocket'] = function(){
		io.Transport['websocket'].apply(this, arguments);
	};
	
	io.util.inherit(Flashsocket, io.Transport['websocket']);
	
	Flashsocket.prototype.type = 'flashsocket';
	
	Flashsocket.prototype.connect = function(){
		var self = this, args = arguments;
		WebSocket.__addTask(function(){
			io.Transport['websocket'].prototype.connect.apply(self, args);
		});
		return this;
	};
	
	Flashsocket.prototype.send = function(){
		var self = this, args = arguments;
		WebSocket.__addTask(function(){
			io.Transport['websocket'].prototype.send.apply(self, args);
		});
		return this;
	};
	
	Flashsocket.check = function(){
		if (typeof WebSocket == 'undefined' || !('__addTask' in WebSocket)) return false;
		if (io.util.opera) return false; // opera is buggy with this transport
		if ('navigator' in window && 'plugins' in navigator && navigator.plugins['Shockwave Flash']){
			return !!navigator.plugins['Shockwave Flash'].description;
	  }
		if ('ActiveXObject' in window) {
			try {
				return !!new ActiveXObject('ShockwaveFlash.ShockwaveFlash').GetVariable('$version');
			} catch (e) {}
		}
		return false;
	};
	
	Flashsocket.xdomainCheck = function(){
		return true;
	};
	
})();
/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
	var HTMLFile = io.Transport['htmlfile'] = function(){
		io.Transport['XHR'].apply(this, arguments);
	};
	
	io.util.inherit(HTMLFile, io.Transport['XHR']);
	
	HTMLFile.prototype.type = 'htmlfile';
	
	HTMLFile.prototype._get = function(){
		var self = this;
		this._open();
		window.attachEvent('onunload', function(){ self._destroy(); });
	};
	
	HTMLFile.prototype._open = function(){
		this._doc = new ActiveXObject('htmlfile');
		this._doc.open();
		this._doc.write('<html></html>');
		this._doc.parentWindow.s = this;
		this._doc.close();

		var _iframeC = this._doc.createElement('div');
		this._doc.body.appendChild(_iframeC);
		this._iframe = this._doc.createElement('iframe');
		_iframeC.appendChild(this._iframe);
		this._iframe.src = this._prepareUrl() + '/' + (+ new Date);
	};
	
	HTMLFile.prototype._ = function(data, doc){
		this._onData(data);
		var script = doc.getElementsByTagName('script')[0];
		script.parentNode.removeChild(script);
	};

  HTMLFile.prototype._destroy = function(){
    if (this._iframe){
      this._iframe.src = 'about:blank';
      this._doc = null;
      CollectGarbage();
    }
  };
	
	HTMLFile.prototype.disconnect = function(){
		this._destroy();
		return io.Transport['XHR'].prototype.disconnect.call(this);
	};
	
	HTMLFile.check = function(){
		if ('ActiveXObject' in window){
			try {
				var a = new ActiveXObject('htmlfile');
				return a && io.Transport['XHR'].check();
			} catch(e){}
		}
		return false;
	};

	HTMLFile.xdomainCheck = function(){
		// we can probably do handling for sub-domains, we should test that it's cross domain but a subdomain here
		return false;
	};
	
})();
/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
	var XHRMultipart = io.Transport['xhr-multipart'] = function(){
		io.Transport['XHR'].apply(this, arguments);
	};
	
	io.util.inherit(XHRMultipart, io.Transport['XHR']);
	
	XHRMultipart.prototype.type = 'xhr-multipart';
	
	XHRMultipart.prototype._get = function(){
		var self = this;
		this._xhr = this._request('', 'GET', true);
		this._xhr.onreadystatechange = function(){
			if (self._xhr.readyState == 4) self._onData(self._xhr.responseText);
		};
		this._xhr.send(null);
	};
	
	XHRMultipart.check = function(){
		return 'XMLHttpRequest' in window && 'prototype' in XMLHttpRequest && 'multipart' in XMLHttpRequest.prototype;
	};

	XHRMultipart.xdomainCheck = function(){
		return true;
	};
	
})();

/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;

	var empty = new Function(),

	XHRPolling = io.Transport['xhr-polling'] = function(){
		io.Transport['XHR'].apply(this, arguments);
	};

	io.util.inherit(XHRPolling, io.Transport['XHR']);

	XHRPolling.prototype.type = 'xhr-polling';

	XHRPolling.prototype.connect = function(){
		if (io.util.ios || io.util.android){
			var self = this;
			io.util.load(function(){
				setTimeout(function(){
					io.Transport['XHR'].prototype.connect.call(self);
				}, 10);
			});
		} else {
			io.Transport['XHR'].prototype.connect.call(this);
		}
	};

	XHRPolling.prototype._get = function(){
		var self = this;
		this._xhr = this._request(+ new Date, 'GET');
    this._xhr.onreadystatechange = function(){
      var status;
      if (self._xhr.readyState == 4){
        self._xhr.onreadystatechange = empty;
        try { status = self._xhr.status; } catch(e){}
        if (status == 200){
          self._onData(self._xhr.responseText);
          self._get();
        } else {
          self._onDisconnect();
        }
      }
    };
		this._xhr.send(null);
	};

	XHRPolling.check = function(){
		return io.Transport['XHR'].check();
	};

	XHRPolling.xdomainCheck = function(){
		return io.Transport['XHR'].xdomainCheck();
	};

})();

/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
	io.JSONP = [];
	
	JSONPPolling = io.Transport['jsonp-polling'] = function(){
		io.Transport['XHR'].apply(this, arguments);
		this._insertAt = document.getElementsByTagName('script')[0];
		this._index = io.JSONP.length;
		io.JSONP.push(this);
	};
	
	io.util.inherit(JSONPPolling, io.Transport['xhr-polling']);
	
	JSONPPolling.prototype.type = 'jsonp-polling';
	
	JSONPPolling.prototype._send = function(data){
		var self = this;
		if (!('_form' in this)){
			var form = document.createElement('FORM'),
				area = document.createElement('TEXTAREA'),
				id = this._iframeId = 'socket_io_iframe_' + this._index,
				iframe;
	
			form.style.position = 'absolute';
			form.style.top = '-1000px';
			form.style.left = '-1000px';
			form.target = id;
			form.method = 'POST';
			form.action = this._prepareUrl() + '/' + (+new Date) + '/' + this._index;
			area.name = 'data';
			form.appendChild(area);
			this._insertAt.parentNode.insertBefore(form, this._insertAt);
			document.body.appendChild(form);
	
			this._form = form;
			this._area = area;
		}
	
		function complete(){
			initIframe();
			self._posting = false;
			self._checkSend();
		};
	
		function initIframe(){
			if (self._iframe){
				self._form.removeChild(self._iframe);
			} 
	
			try {
				// ie6 dynamic iframes with target="" support (thanks Chris Lambacher)
				iframe = document.createElement('<iframe name="'+ self._iframeId +'">');
			} catch(e){
				iframe = document.createElement('iframe');
				iframe.name = self._iframeId;
			}
	
			iframe.id = self._iframeId;
	
			self._form.appendChild(iframe);
			self._iframe = iframe;
		};
	
		initIframe();
	
		this._posting = true;
		this._area.value = data;
	
		try {
			this._form.submit();
		} catch(e){}
	
		if (this._iframe.attachEvent){
			iframe.onreadystatechange = function(){
				if (self._iframe.readyState == 'complete') complete();
			};
		} else {
			this._iframe.onload = complete;
		}
	};
	
	JSONPPolling.prototype._get = function(){
		var self = this,
				script = document.createElement('SCRIPT');
		if (this._script){
			this._script.parentNode.removeChild(this._script);
			this._script = null;
		}
		script.async = true;
		script.src = this._prepareUrl() + '/' + (+new Date) + '/' + this._index;
		script.onerror = function(){
			self._onDisconnect();
		};
		this._insertAt.parentNode.insertBefore(script, this._insertAt);
		this._script = script;
	};
	
	JSONPPolling.prototype._ = function(){
		this._onData.apply(this, arguments);
		this._get();
		return this;
	};
	
	JSONPPolling.check = function(){
		return true;
	};
	
	JSONPPolling.xdomainCheck = function(){
		return true;
	};
})();
/**
 * Socket.IO client
 * 
 * @author Guillermo Rauch <guillermo@learnboost.com>
 * @license The MIT license.
 * @copyright Copyright (c) 2010 LearnBoost <dev@learnboost.com>
 */

(function(){
	var io = this.io;
	
	var Socket = io.Socket = function(host, options){
		this.host = host || document.domain;
		this.options = {
			secure: false,
			document: document,
			port: document.location.port || 80,
			resource: 'socket.io',
			transports: ['websocket', 'flashsocket', 'htmlfile', 'xhr-multipart', 'xhr-polling', 'jsonp-polling'],
			transportOptions: {
				'xhr-polling': {
					timeout: 25000 // based on polling duration default
				},
				'jsonp-polling': {
					timeout: 25000
				}
			},
			connectTimeout: 5000,
			reconnect: true,
			reconnectionDelay: 500,
			maxReconnectionAttempts: 10,
			tryTransportsOnConnectTimeout: true,
			rememberTransport: true
		};
		io.util.merge(this.options, options);
		this.connected = false;
		this.connecting = false;
		this._events = {};
		this.transport = this.getTransport();
		if (!this.transport && 'console' in window) console.error('No transport available');
	};
	
	Socket.prototype.getTransport = function(override){
		var transports = override || this.options.transports, match;
		if (this.options.rememberTransport && !override){
			match = this.options.document.cookie.match('(?:^|;)\\s*socketio=([^;]*)');
			if (match){
				this._rememberedTransport = true;
				transports = [decodeURIComponent(match[1])];
			}
		} 
		for (var i = 0, transport; transport = transports[i]; i++){
			if (io.Transport[transport] 
				&& io.Transport[transport].check() 
				&& (!this._isXDomain() || io.Transport[transport].xdomainCheck())){
				return new io.Transport[transport](this, this.options.transportOptions[transport] || {});
			}
		}
		return null;
	};
	
	Socket.prototype.connect = function(){
		if (this.transport && !this.connected){
			if (this.connecting) this.disconnect(true);
			this.connecting = true;
			this.emit('connecting', [this.transport.type]);
			this.transport.connect();
			if (this.options.connectTimeout){
				var self = this;
				this.connectTimeoutTimer = setTimeout(function(){
					if (!self.connected){
						self.disconnect(true);
						if (self.options.tryTransportsOnConnectTimeout && !self._rememberedTransport){
							if(!self._remainingTransports) self._remainingTransports = self.options.transports.slice(0);
							var transports = self._remainingTransports;
							while(transports.length > 0 && transports.splice(0,1)[0] != self.transport.type){}
							if(transports.length){
								self.transport = self.getTransport(transports);
								self.connect();
							}
						}
						if(!self._remainingTransports || self._remainingTransports.length == 0) self.emit('connect_failed');
					}
					if(self._remainingTransports && self._remainingTransports.length == 0) delete self._remainingTransports;
				}, this.options.connectTimeout);
			}
		}
		return this;
	};
	
	Socket.prototype.send = function(data){
		if (!this.transport || !this.transport.connected) return this._queue(data);
		this.transport.send(data);
		return this;
	};
	
	Socket.prototype.disconnect = function(reconnect){
    if (this.connectTimeoutTimer) clearTimeout(this.connectTimeoutTimer);
		if (!reconnect) this.options.reconnect = false;
		this.transport.disconnect();
		return this;
	};
	
	Socket.prototype.on = function(name, fn){
		if (!(name in this._events)) this._events[name] = [];
		this._events[name].push(fn);
		return this;
	};
	
  Socket.prototype.emit = function(name, args){
    if (name in this._events){
      var events = this._events[name].concat();
      for (var i = 0, ii = events.length; i < ii; i++)
        events[i].apply(this, args === undefined ? [] : args);
    }
    return this;
  };

	Socket.prototype.removeEvent = function(name, fn){
		if (name in this._events){
			for (var a = 0, l = this._events[name].length; a < l; a++)
				if (this._events[name][a] == fn) this._events[name].splice(a, 1);		
		}
		return this;
	};
	
	Socket.prototype._queue = function(message){
		if (!('_queueStack' in this)) this._queueStack = [];
		this._queueStack.push(message);
		return this;
	};
	
	Socket.prototype._doQueue = function(){
		if (!('_queueStack' in this) || !this._queueStack.length) return this;
		this.transport.send(this._queueStack);
		this._queueStack = [];
		return this;
	};
	
	Socket.prototype._isXDomain = function(){
    var locPort = window.location.port || 80;
		return this.host !== document.domain || this.options.port != locPort;
	};
	
	Socket.prototype._onConnect = function(){
		this.connected = true;
		this.connecting = false;
		this._doQueue();
		if (this.options.rememberTransport) this.options.document.cookie = 'socketio=' + encodeURIComponent(this.transport.type);
		this.emit('connect');
	};
	
	Socket.prototype._onMessage = function(data){
		this.emit('message', [data]);
	};
	
	Socket.prototype._onDisconnect = function(){
		var wasConnected = this.connected;
		this.connected = false;
		this.connecting = false;
		this._queueStack = [];
		if (wasConnected){
			this.emit('disconnect');
			if (this.options.reconnect && !this.reconnecting) this._onReconnect();
		}
	};
	
	Socket.prototype._onReconnect = function(){
		this.reconnecting = true;
		this.reconnectionAttempts = 0;
		this.reconnectionDelay = this.options.reconnectionDelay;
		
		var self = this
			, tryTransportsOnConnectTimeout = this.options.tryTransportsOnConnectTimeout
			, rememberTransport = this.options.rememberTransport;
		
		function reset(){
			if(self.connected) self.emit('reconnect',[self.transport.type,self.reconnectionAttempts]);
			self.removeEvent('connect_failed', maybeReconnect).removeEvent('connect', maybeReconnect);
			delete self.reconnecting;
			delete self.reconnectionAttempts;
			delete self.reconnectionDelay;
			delete self.reconnectionTimer;
			delete self.redoTransports;
			self.options.tryTransportsOnConnectTimeout = tryTransportsOnConnectTimeout;
			self.options.rememberTransport = rememberTransport;
			
			return;
		};
		
		function maybeReconnect(){
			if (!self.reconnecting) return;
			if (!self.connected){
				if (self.connecting && self.reconnecting) return self.reconnectionTimer = setTimeout(maybeReconnect, 1000);
				
				if (self.reconnectionAttempts++ >= self.options.maxReconnectionAttempts){
					if (!self.redoTransports){
						self.on('connect_failed', maybeReconnect);
						self.options.tryTransportsOnConnectTimeout = true;
						self.transport = self.getTransport(self.options.transports); // overwrite with all enabled transports
						self.redoTransports = true;
						self.connect();
					} else {
						self.emit('reconnect_failed');
						reset();
					}
				} else {
					self.reconnectionDelay *= 2; // exponential backoff
					self.connect();
					self.emit('reconnecting', [self.reconnectionDelay,self.reconnectionAttempts]);
					self.reconnectionTimer = setTimeout(maybeReconnect, self.reconnectionDelay);
				}
			} else {
				reset();
			}
		};
		this.options.tryTransportsOnConnectTimeout = false;
		this.reconnectionTimer = setTimeout(maybeReconnect, this.reconnectionDelay);
		
		this.on('connect', maybeReconnect);
	};

  Socket.prototype.fire = Socket.prototype.emit;
	Socket.prototype.addListener = Socket.prototype.addEvent = Socket.prototype.addEventListener = Socket.prototype.on;
	Socket.prototype.removeListener = Socket.prototype.removeEventListener = Socket.prototype.removeEvent;
	
})();
/*	SWFObject v2.2 <http://code.google.com/p/swfobject/> 
	is released under the MIT License <http://www.opensource.org/licenses/mit-license.php> 
*/
var swfobject=function(){var D="undefined",r="object",S="Shockwave Flash",W="ShockwaveFlash.ShockwaveFlash",q="application/x-shockwave-flash",R="SWFObjectExprInst",x="onreadystatechange",O=window,j=document,t=navigator,T=false,U=[h],o=[],N=[],I=[],l,Q,E,B,J=false,a=false,n,G,m=true,M=function(){var aa=typeof j.getElementById!=D&&typeof j.getElementsByTagName!=D&&typeof j.createElement!=D,ah=t.userAgent.toLowerCase(),Y=t.platform.toLowerCase(),ae=Y?/win/.test(Y):/win/.test(ah),ac=Y?/mac/.test(Y):/mac/.test(ah),af=/webkit/.test(ah)?parseFloat(ah.replace(/^.*webkit\/(\d+(\.\d+)?).*$/,"$1")):false,X=!+"\v1",ag=[0,0,0],ab=null;if(typeof t.plugins!=D&&typeof t.plugins[S]==r){ab=t.plugins[S].description;if(ab&&!(typeof t.mimeTypes!=D&&t.mimeTypes[q]&&!t.mimeTypes[q].enabledPlugin)){T=true;X=false;ab=ab.replace(/^.*\s+(\S+\s+\S+$)/,"$1");ag[0]=parseInt(ab.replace(/^(.*)\..*$/,"$1"),10);ag[1]=parseInt(ab.replace(/^.*\.(.*)\s.*$/,"$1"),10);ag[2]=/[a-zA-Z]/.test(ab)?parseInt(ab.replace(/^.*[a-zA-Z]+(.*)$/,"$1"),10):0}}else{if(typeof O.ActiveXObject!=D){try{var ad=new ActiveXObject(W);if(ad){ab=ad.GetVariable("$version");if(ab){X=true;ab=ab.split(" ")[1].split(",");ag=[parseInt(ab[0],10),parseInt(ab[1],10),parseInt(ab[2],10)]}}}catch(Z){}}}return{w3:aa,pv:ag,wk:af,ie:X,win:ae,mac:ac}}(),k=function(){if(!M.w3){return}if((typeof j.readyState!=D&&j.readyState=="complete")||(typeof j.readyState==D&&(j.getElementsByTagName("body")[0]||j.body))){f()}if(!J){if(typeof j.addEventListener!=D){j.addEventListener("DOMContentLoaded",f,false)}if(M.ie&&M.win){j.attachEvent(x,function(){if(j.readyState=="complete"){j.detachEvent(x,arguments.callee);f()}});if(O==top){(function(){if(J){return}try{j.documentElement.doScroll("left")}catch(X){setTimeout(arguments.callee,0);return}f()})()}}if(M.wk){(function(){if(J){return}if(!/loaded|complete/.test(j.readyState)){setTimeout(arguments.callee,0);return}f()})()}s(f)}}();function f(){if(J){return}try{var Z=j.getElementsByTagName("body")[0].appendChild(C("span"));Z.parentNode.removeChild(Z)}catch(aa){return}J=true;var X=U.length;for(var Y=0;Y<X;Y++){U[Y]()}}function K(X){if(J){X()}else{U[U.length]=X}}function s(Y){if(typeof O.addEventListener!=D){O.addEventListener("load",Y,false)}else{if(typeof j.addEventListener!=D){j.addEventListener("load",Y,false)}else{if(typeof O.attachEvent!=D){i(O,"onload",Y)}else{if(typeof O.onload=="function"){var X=O.onload;O.onload=function(){X();Y()}}else{O.onload=Y}}}}}function h(){if(T){V()}else{H()}}function V(){var X=j.getElementsByTagName("body")[0];var aa=C(r);aa.setAttribute("type",q);var Z=X.appendChild(aa);if(Z){var Y=0;(function(){if(typeof Z.GetVariable!=D){var ab=Z.GetVariable("$version");if(ab){ab=ab.split(" ")[1].split(",");M.pv=[parseInt(ab[0],10),parseInt(ab[1],10),parseInt(ab[2],10)]}}else{if(Y<10){Y++;setTimeout(arguments.callee,10);return}}X.removeChild(aa);Z=null;H()})()}else{H()}}function H(){var ag=o.length;if(ag>0){for(var af=0;af<ag;af++){var Y=o[af].id;var ab=o[af].callbackFn;var aa={success:false,id:Y};if(M.pv[0]>0){var ae=c(Y);if(ae){if(F(o[af].swfVersion)&&!(M.wk&&M.wk<312)){w(Y,true);if(ab){aa.success=true;aa.ref=z(Y);ab(aa)}}else{if(o[af].expressInstall&&A()){var ai={};ai.data=o[af].expressInstall;ai.width=ae.getAttribute("width")||"0";ai.height=ae.getAttribute("height")||"0";if(ae.getAttribute("class")){ai.styleclass=ae.getAttribute("class")}if(ae.getAttribute("align")){ai.align=ae.getAttribute("align")}var ah={};var X=ae.getElementsByTagName("param");var ac=X.length;for(var ad=0;ad<ac;ad++){if(X[ad].getAttribute("name").toLowerCase()!="movie"){ah[X[ad].getAttribute("name")]=X[ad].getAttribute("value")}}P(ai,ah,Y,ab)}else{p(ae);if(ab){ab(aa)}}}}}else{w(Y,true);if(ab){var Z=z(Y);if(Z&&typeof Z.SetVariable!=D){aa.success=true;aa.ref=Z}ab(aa)}}}}}function z(aa){var X=null;var Y=c(aa);if(Y&&Y.nodeName=="OBJECT"){if(typeof Y.SetVariable!=D){X=Y}else{var Z=Y.getElementsByTagName(r)[0];if(Z){X=Z}}}return X}function A(){return !a&&F("6.0.65")&&(M.win||M.mac)&&!(M.wk&&M.wk<312)}function P(aa,ab,X,Z){a=true;E=Z||null;B={success:false,id:X};var ae=c(X);if(ae){if(ae.nodeName=="OBJECT"){l=g(ae);Q=null}else{l=ae;Q=X}aa.id=R;if(typeof aa.width==D||(!/%$/.test(aa.width)&&parseInt(aa.width,10)<310)){aa.width="310"}if(typeof aa.height==D||(!/%$/.test(aa.height)&&parseInt(aa.height,10)<137)){aa.height="137"}j.title=j.title.slice(0,47)+" - Flash Player Installation";var ad=M.ie&&M.win?"ActiveX":"PlugIn",ac="MMredirectURL="+O.location.toString().replace(/&/g,"%26")+"&MMplayerType="+ad+"&MMdoctitle="+j.title;if(typeof ab.flashvars!=D){ab.flashvars+="&"+ac}else{ab.flashvars=ac}if(M.ie&&M.win&&ae.readyState!=4){var Y=C("div");X+="SWFObjectNew";Y.setAttribute("id",X);ae.parentNode.insertBefore(Y,ae);ae.style.display="none";(function(){if(ae.readyState==4){ae.parentNode.removeChild(ae)}else{setTimeout(arguments.callee,10)}})()}u(aa,ab,X)}}function p(Y){if(M.ie&&M.win&&Y.readyState!=4){var X=C("div");Y.parentNode.insertBefore(X,Y);X.parentNode.replaceChild(g(Y),X);Y.style.display="none";(function(){if(Y.readyState==4){Y.parentNode.removeChild(Y)}else{setTimeout(arguments.callee,10)}})()}else{Y.parentNode.replaceChild(g(Y),Y)}}function g(ab){var aa=C("div");if(M.win&&M.ie){aa.innerHTML=ab.innerHTML}else{var Y=ab.getElementsByTagName(r)[0];if(Y){var ad=Y.childNodes;if(ad){var X=ad.length;for(var Z=0;Z<X;Z++){if(!(ad[Z].nodeType==1&&ad[Z].nodeName=="PARAM")&&!(ad[Z].nodeType==8)){aa.appendChild(ad[Z].cloneNode(true))}}}}}return aa}function u(ai,ag,Y){var X,aa=c(Y);if(M.wk&&M.wk<312){return X}if(aa){if(typeof ai.id==D){ai.id=Y}if(M.ie&&M.win){var ah="";for(var ae in ai){if(ai[ae]!=Object.prototype[ae]){if(ae.toLowerCase()=="data"){ag.movie=ai[ae]}else{if(ae.toLowerCase()=="styleclass"){ah+=' class="'+ai[ae]+'"'}else{if(ae.toLowerCase()!="classid"){ah+=" "+ae+'="'+ai[ae]+'"'}}}}}var af="";for(var ad in ag){if(ag[ad]!=Object.prototype[ad]){af+='<param name="'+ad+'" value="'+ag[ad]+'" />'}}aa.outerHTML='<object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"'+ah+">"+af+"</object>";N[N.length]=ai.id;X=c(ai.id)}else{var Z=C(r);Z.setAttribute("type",q);for(var ac in ai){if(ai[ac]!=Object.prototype[ac]){if(ac.toLowerCase()=="styleclass"){Z.setAttribute("class",ai[ac])}else{if(ac.toLowerCase()!="classid"){Z.setAttribute(ac,ai[ac])}}}}for(var ab in ag){if(ag[ab]!=Object.prototype[ab]&&ab.toLowerCase()!="movie"){e(Z,ab,ag[ab])}}aa.parentNode.replaceChild(Z,aa);X=Z}}return X}function e(Z,X,Y){var aa=C("param");aa.setAttribute("name",X);aa.setAttribute("value",Y);Z.appendChild(aa)}function y(Y){var X=c(Y);if(X&&X.nodeName=="OBJECT"){if(M.ie&&M.win){X.style.display="none";(function(){if(X.readyState==4){b(Y)}else{setTimeout(arguments.callee,10)}})()}else{X.parentNode.removeChild(X)}}}function b(Z){var Y=c(Z);if(Y){for(var X in Y){if(typeof Y[X]=="function"){Y[X]=null}}Y.parentNode.removeChild(Y)}}function c(Z){var X=null;try{X=j.getElementById(Z)}catch(Y){}return X}function C(X){return j.createElement(X)}function i(Z,X,Y){Z.attachEvent(X,Y);I[I.length]=[Z,X,Y]}function F(Z){var Y=M.pv,X=Z.split(".");X[0]=parseInt(X[0],10);X[1]=parseInt(X[1],10)||0;X[2]=parseInt(X[2],10)||0;return(Y[0]>X[0]||(Y[0]==X[0]&&Y[1]>X[1])||(Y[0]==X[0]&&Y[1]==X[1]&&Y[2]>=X[2]))?true:false}function v(ac,Y,ad,ab){if(M.ie&&M.mac){return}var aa=j.getElementsByTagName("head")[0];if(!aa){return}var X=(ad&&typeof ad=="string")?ad:"screen";if(ab){n=null;G=null}if(!n||G!=X){var Z=C("style");Z.setAttribute("type","text/css");Z.setAttribute("media",X);n=aa.appendChild(Z);if(M.ie&&M.win&&typeof j.styleSheets!=D&&j.styleSheets.length>0){n=j.styleSheets[j.styleSheets.length-1]}G=X}if(M.ie&&M.win){if(n&&typeof n.addRule==r){n.addRule(ac,Y)}}else{if(n&&typeof j.createTextNode!=D){n.appendChild(j.createTextNode(ac+" {"+Y+"}"))}}}function w(Z,X){if(!m){return}var Y=X?"visible":"hidden";if(J&&c(Z)){c(Z).style.visibility=Y}else{v("#"+Z,"visibility:"+Y)}}function L(Y){var Z=/[\\\"<>\.;]/;var X=Z.exec(Y)!=null;return X&&typeof encodeURIComponent!=D?encodeURIComponent(Y):Y}var d=function(){if(M.ie&&M.win){window.attachEvent("onunload",function(){var ac=I.length;for(var ab=0;ab<ac;ab++){I[ab][0].detachEvent(I[ab][1],I[ab][2])}var Z=N.length;for(var aa=0;aa<Z;aa++){y(N[aa])}for(var Y in M){M[Y]=null}M=null;for(var X in swfobject){swfobject[X]=null}swfobject=null})}}();return{registerObject:function(ab,X,aa,Z){if(M.w3&&ab&&X){var Y={};Y.id=ab;Y.swfVersion=X;Y.expressInstall=aa;Y.callbackFn=Z;o[o.length]=Y;w(ab,false)}else{if(Z){Z({success:false,id:ab})}}},getObjectById:function(X){if(M.w3){return z(X)}},embedSWF:function(ab,ah,ae,ag,Y,aa,Z,ad,af,ac){var X={success:false,id:ah};if(M.w3&&!(M.wk&&M.wk<312)&&ab&&ah&&ae&&ag&&Y){w(ah,false);K(function(){ae+="";ag+="";var aj={};if(af&&typeof af===r){for(var al in af){aj[al]=af[al]}}aj.data=ab;aj.width=ae;aj.height=ag;var am={};if(ad&&typeof ad===r){for(var ak in ad){am[ak]=ad[ak]}}if(Z&&typeof Z===r){for(var ai in Z){if(typeof am.flashvars!=D){am.flashvars+="&"+ai+"="+Z[ai]}else{am.flashvars=ai+"="+Z[ai]}}}if(F(Y)){var an=u(aj,am,ah);if(aj.id==ah){w(ah,true)}X.success=true;X.ref=an}else{if(aa&&A()){aj.data=aa;P(aj,am,ah,ac);return}else{w(ah,true)}}if(ac){ac(X)}})}else{if(ac){ac(X)}}},switchOffAutoHideShow:function(){m=false},ua:M,getFlashPlayerVersion:function(){return{major:M.pv[0],minor:M.pv[1],release:M.pv[2]}},hasFlashPlayerVersion:F,createSWF:function(Z,Y,X){if(M.w3){return u(Z,Y,X)}else{return undefined}},showExpressInstall:function(Z,aa,X,Y){if(M.w3&&A()){P(Z,aa,X,Y)}},removeSWF:function(X){if(M.w3){y(X)}},createCSS:function(aa,Z,Y,X){if(M.w3){v(aa,Z,Y,X)}},addDomLoadEvent:K,addLoadEvent:s,getQueryParamValue:function(aa){var Z=j.location.search||j.location.hash;if(Z){if(/\?/.test(Z)){Z=Z.split("?")[1]}if(aa==null){return L(Z)}var Y=Z.split("&");for(var X=0;X<Y.length;X++){if(Y[X].substring(0,Y[X].indexOf("="))==aa){return L(Y[X].substring((Y[X].indexOf("=")+1)))}}}return""},expressInstallCallback:function(){if(a){var X=c(R);if(X&&l){X.parentNode.replaceChild(l,X);if(Q){w(Q,true);if(M.ie&&M.win){l.style.display="block"}}if(E){E(B)}}a=false}}}}();
// Copyright: Hiroshi Ichikawa <http://gimite.net/en/>
// License: New BSD License
// Reference: http://dev.w3.org/html5/websockets/
// Reference: http://tools.ietf.org/html/draft-hixie-thewebsocketprotocol

(function() {
  
  if ('WebSocket' in window) return;

  var console = window.console;
  if (!console || !console.log || !console.error) {
    console = {log: function(){ }, error: function(){ }};
  }
  
  if (!swfobject.hasFlashPlayerVersion("10.0.0")) {
    console.error("Flash Player >= 10.0.0 is required.");
    return;
  }
  if (location.protocol == "file:") {
    console.error(
      "WARNING: web-socket-js doesn't work in file:///... URL " +
      "unless you set Flash Security Settings properly. " +
      "Open the page via Web server i.e. http://...");
  }

  /**
   * This class represents a faux web socket.
   * @param {string} url
   * @param {string} protocol
   * @param {string} proxyHost
   * @param {int} proxyPort
   * @param {string} headers
   */
  WebSocket = function(url, protocol, proxyHost, proxyPort, headers) {
    var self = this;
    self.__id = WebSocket.__nextId++;
    WebSocket.__instances[self.__id] = self;
    self.readyState = WebSocket.CONNECTING;
    self.bufferedAmount = 0;
    // Uses setTimeout() to make sure __createFlash() runs after the caller sets ws.onopen etc.
    // Otherwise, when onopen fires immediately, onopen is called before it is set.
    setTimeout(function() {
      WebSocket.__addTask(function() {
        WebSocket.__flash.create(
            self.__id, url, protocol, proxyHost || null, proxyPort || 0, headers || null);
      });
    }, 0);
  };

  /**
   * Send data to the web socket.
   * @param {string} data  The data to send to the socket.
   * @return {boolean}  True for success, false for failure.
   */
  WebSocket.prototype.send = function(data) {
    if (this.readyState == WebSocket.CONNECTING) {
      throw "INVALID_STATE_ERR: Web Socket connection has not been established";
    }
    // We use encodeURIComponent() here, because FABridge doesn't work if
    // the argument includes some characters. We don't use escape() here
    // because of this:
    // https://developer.mozilla.org/en/Core_JavaScript_1.5_Guide/Functions#escape_and_unescape_Functions
    // But it looks decodeURIComponent(encodeURIComponent(s)) doesn't
    // preserve all Unicode characters either e.g. "\uffff" in Firefox.
    // Note by wtritch: Hopefully this will not be necessary using ExternalInterface.  Will require
    // additional testing.
    var result = WebSocket.__flash.send(this.__id, encodeURIComponent(data));
    if (result < 0) { // success
      return true;
    } else {
      this.bufferedAmount += result;
      return false;
    }
  };

  /**
   * Close this web socket gracefully.
   */
  WebSocket.prototype.close = function() {
    if (this.readyState == WebSocket.CLOSED || this.readyState == WebSocket.CLOSING) {
      return;
    }
    this.readyState = WebSocket.CLOSING;
    WebSocket.__flash.close(this.__id);
  };

  /**
   * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
   *
   * @param {string} type
   * @param {function} listener
   * @param {boolean} useCapture !NB Not implemented yet
   * @return void
   */
  WebSocket.prototype.addEventListener = function(type, listener, useCapture) {
    if (!('__events' in this)) {
      this.__events = {};
    }
    if (!(type in this.__events)) {
      this.__events[type] = [];
      if ('function' == typeof this['on' + type]) {
        this.__events[type].defaultHandler = this['on' + type];
        this['on' + type] = this.__createEventHandler(this, type);
      }
    }
    this.__events[type].push(listener);
  };

  /**
   * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
   *
   * @param {string} type
   * @param {function} listener
   * @param {boolean} useCapture NB! Not implemented yet
   * @return void
   */
  WebSocket.prototype.removeEventListener = function(type, listener, useCapture) {
    if (!('__events' in this)) {
      this.__events = {};
    }
    if (!(type in this.__events)) return;
    for (var i = this.__events.length; i > -1; --i) {
      if (listener === this.__events[type][i]) {
        this.__events[type].splice(i, 1);
        break;
      }
    }
  };

  /**
   * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
   *
   * @param {WebSocketEvent} event
   * @return void
   */
  WebSocket.prototype.dispatchEvent = function(event) {
    if (!('__events' in this)) throw 'UNSPECIFIED_EVENT_TYPE_ERR';
    if (!(event.type in this.__events)) throw 'UNSPECIFIED_EVENT_TYPE_ERR';
  
    for (var i = 0, l = this.__events[event.type].length; i < l; ++ i) {
      this.__events[event.type][i](event);
      if (event.cancelBubble) break;
    }
  
    if (false !== event.returnValue &&
      'function' == typeof this.__events[event.type].defaultHandler)
    {
      this.__events[event.type].defaultHandler(event);
    }
  };

  /**
   * Handle an event from flash.  Do any websocket-specific
   * handling before passing the event off to the event handlers.
   * @param {Object} event
   */
  WebSocket.prototype.__handleEvent = function(event) {
    if ("readyState" in event) {
      this.readyState = event.readyState;
    }
  
    try {
      if (event.type == "open") {
        this.onopen && this.onopen();
      } else if (event.type == "close") {
        this.onclose && this.onclose();
      } else if (event.type == "error") {
        this.onerror && this.onerror(event);
      } else if (event.type == "message") {
        if (this.onmessage) {
          var data = decodeURIComponent(event.message);
          var e;
          if (window.MessageEvent && !window.opera) {
            e = document.createEvent("MessageEvent");
            e.initMessageEvent("message", false, false, data, null, null, window, null);
          } else {
            // IE and Opera, the latter one truncates the data parameter after any 0x00 bytes.
            e = {data: data};
          }
          this.onmessage(e);
        }
        
      } else {
        throw "unknown event type: " + event.type;
      }
    } catch (e) {
      console.error(e.toString());
    }
  };
  
  /**
   * @param {object} object
   * @param {string} type
   */
  WebSocket.prototype.__createEventHandler = function(object, type) {
    return function(data) {
      var event = new WebSocketEvent();
      event.initEvent(type, true, true);
      event.target = event.currentTarget = object;
      for (var key in data) {
        event[key] = data[key];
      }
      object.dispatchEvent(event, arguments);
    };
  };

  /**
   * Define the WebSocket readyState enumeration.
   */
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;

  WebSocket.__flash = null;
  WebSocket.__instances = {};
  WebSocket.__tasks = [];
  WebSocket.__nextId = 0;
  
  /**
   * Loads WebSocketMain.swf and creates WebSocketMain object in Flash.
   */
  WebSocket.__initialize = function() {
    if (WebSocket.__flash) return;
    
    if (WebSocket.__swfLocation) {
      // For backword compatibility.
      window.WEB_SOCKET_SWF_LOCATION = WebSocket.__swfLocation;
    }
    if (!window.WEB_SOCKET_SWF_LOCATION) {
      console.error("[WebSocket] set WEB_SOCKET_SWF_LOCATION to location of WebSocketMain.swf");
      return;
    }
    var container = document.createElement("div");
    container.id = "webSocketContainer";
    // Hides Flash box. We cannot use display: none or visibility: hidden because it prevents
    // Flash from loading at least in IE. So we move it out of the screen at (-100, -100).
    // But this even doesn't work with Flash Lite (e.g. in Droid Incredible). So with Flash
    // Lite, we put it at (0, 0). This shows 1x1 box visible at left-top corner but this is
    // the best we can do as far as we know now.
    container.style.position = "absolute";
    if (WebSocket.__isFlashLite()) {
      container.style.left = "0px";
      container.style.top = "0px";
    } else {
      container.style.left = "-100px";
      container.style.top = "-100px";
    }
    var holder = document.createElement("div");
    holder.id = "webSocketFlash";
    container.appendChild(holder);
    document.body.appendChild(container);
    // See this article for hasPriority:
    // http://help.adobe.com/en_US/as3/mobile/WS4bebcd66a74275c36cfb8137124318eebc6-7ffd.html
    swfobject.embedSWF(
      WEB_SOCKET_SWF_LOCATION,
      "webSocketFlash",
      "1" /* width */,
      "1" /* height */,
      "10.0.0" /* SWF version */,
      null,
      null,
      {hasPriority: true, swliveconnect : true, allowScriptAccess: "always"},
      null,
      function(e) {
        if (!e.success) {
          console.error("[WebSocket] swfobject.embedSWF failed");
        }
      });
  };
  
  /**
   * Load a new flash security policy file.
   * @param {string} url
   */
  WebSocket.loadFlashPolicyFile = function(url){
    WebSocket.__addTask(function() {
      WebSocket.__flash.loadManualPolicyFile(url);
    });
  };

  /**
   * Called by flash to notify js that it's fully loaded and ready
   * for communication.
   */
  WebSocket.__onFlashInitialized = function() {
    // We need to set a timeout here to avoid round-trip calls
    // to flash during the initialization process.
    setTimeout(function() {
      WebSocket.__flash = document.getElementById("webSocketFlash");
      WebSocket.__flash.setCallerUrl(location.href);
      WebSocket.__flash.setDebug(!!window.WEB_SOCKET_DEBUG);
      for (var i = 0; i < WebSocket.__tasks.length; ++i) {
        WebSocket.__tasks[i]();
      }
      WebSocket.__tasks = [];
    }, 0);
  };
  
  /**
   * Called by flash to dispatch an event to a web socket.
   * @param {object} eventObj  A web socket event dispatched from flash.
   */
  WebSocket.__onFlashEvent = function() {
    setTimeout(function() {
      // Gets events using receiveEvents() instead of getting it from event object
      // of Flash event. This is to make sure to keep message order.
      // It seems sometimes Flash events don't arrive in the same order as they are sent.
      var events = WebSocket.__flash.receiveEvents();
      for (var i = 0; i < events.length; ++i) {
        WebSocket.__instances[events[i].webSocketId].__handleEvent(events[i]);
      }
    }, 0);
    return true;
  };
  
  // called from Flash
  WebSocket.__log = function(message) {
    console.log(decodeURIComponent(message));
  };
  
  // called from Flash
  WebSocket.__error = function(message) {
    console.error(decodeURIComponent(message));
  };
  
  WebSocket.__addTask = function(task) {
    if (WebSocket.__flash) {
      task();
    } else {
      WebSocket.__tasks.push(task);
    }
  };
  
  /**
   * Test if the browser is running flash lite.
   * @return {boolean} True if flash lite is running, false otherwise.
   */
  WebSocket.__isFlashLite = function() {
    if (!window.navigator || !window.navigator.mimeTypes) {
      return false;
    }
    var mimeType = window.navigator.mimeTypes["application/x-shockwave-flash"];
    if (!mimeType || !mimeType.enabledPlugin || !mimeType.enabledPlugin.filename) {
      return false;
    }
    return mimeType.enabledPlugin.filename.match(/flashlite/i) ? true : false;
  };
  
  /**
   * Basic implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-interface">DOM 2 EventInterface</a>}
   *
   * @class
   * @constructor
   */
  function WebSocketEvent(){}
  
  /**
   *
   * @type boolean
   */
  WebSocketEvent.prototype.cancelable = true;
  
  /**
  *
  * @type boolean
  */
  WebSocketEvent.prototype.cancelBubble = false;
  
  /**
  *
  * @return void
  */
  WebSocketEvent.prototype.preventDefault = function() {
    if (this.cancelable) {
      this.returnValue = false;
    }
  };
  
  /**
  *
  * @return void
  */
  WebSocketEvent.prototype.stopPropagation = function() {
    this.cancelBubble = true;
  };

  /**
  *
  * @param {string} eventTypeArg
  * @param {boolean} canBubbleArg
  * @param {boolean} cancelableArg
  * @return void
  */
  WebSocketEvent.prototype.initEvent = function(eventTypeArg, canBubbleArg, cancelableArg) {
    this.type = eventTypeArg;
    this.cancelable = cancelableArg;
    this.timeStamp = new Date();
  };

  if (!window.WEB_SOCKET_DISABLE_AUTO_INITIALIZATION) {
    if (window.addEventListener) {
      window.addEventListener("load", function(){
        WebSocket.__initialize();
      }, false);
    } else {
      window.attachEvent("onload", function(){
        WebSocket.__initialize();
      });
    }
  }
  
})();

(function() {
  var jsondiff;
  var __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; }, __hasProp = Object.prototype.hasOwnProperty;
  jsondiff = (function() {
    function jsondiff() {
      this.patch_apply_with_offsets = __bind(this.patch_apply_with_offsets, this);
      this.transform_object_diff = __bind(this.transform_object_diff, this);
      this.transform_list_diff = __bind(this.transform_list_diff, this);
      this.apply_object_diff_with_offsets = __bind(this.apply_object_diff_with_offsets, this);
      this.apply_object_diff = __bind(this.apply_object_diff, this);
      this.apply_list_diff = __bind(this.apply_list_diff, this);
      this.diff = __bind(this.diff, this);
      this.object_diff = __bind(this.object_diff, this);
      this.list_diff = __bind(this.list_diff, this);
      this._common_suffix = __bind(this._common_suffix, this);
      this._common_prefix = __bind(this._common_prefix, this);
      this.object_equals = __bind(this.object_equals, this);
      this.list_equals = __bind(this.list_equals, this);
      this.equals = __bind(this.equals, this);
      this.deepCopy = __bind(this.deepCopy, this);
      this.typeOf = __bind(this.typeOf, this);
      this.entries = __bind(this.entries, this);
    }
    jsondiff.dmp = new diff_match_patch();
    jsondiff.prototype.entries = function(obj) {
      var key, n, value;
      n = 0;
      for (key in obj) {
        if (!__hasProp.call(obj, key)) continue;
        value = obj[key];
        n++;
      }
      return n;
    };
    jsondiff.prototype.typeOf = function(value) {
      var s;
      s = typeof value;
      if (s === 'object') {
        if (value) {
          if (typeof value.length === 'number' && typeof value.splice === 'function' && !value.propertyIsEnumerable('length')) {
            s = 'array';
          }
        } else {
          s = 'null';
        }
      }
      return s;
    };
    jsondiff.prototype.deepCopy = function(obj) {
      var i, out, _ref;
      if (Object.prototype.toString.call(obj) === '[object Array]') {
        out = [];
        for (i = 0, _ref = obj.length; 0 <= _ref ? i < _ref : i > _ref; 0 <= _ref ? i++ : i--) {
          out[i] = arguments.callee(obj[i]);
        }
        return out;
      }
      if (typeof obj === 'object') {
        out = {};
        for (i in obj) {
          out[i] = arguments.callee(obj[i]);
        }
        return out;
      }
      return obj;
    };
    jsondiff.prototype.equals = function(a, b) {
      var typea;
      typea = this.typeOf(a);
      if (typea !== this.typeOf(b)) {
        return false;
      }
      if (typea === 'array') {
        return this.list_equals(a, b);
      } else if (typea === 'object') {
        return this.object_equals(a, b);
      } else {
        return a === b;
      }
    };
    jsondiff.prototype.list_equals = function(a, b) {
      var alength, i;
      alength = a.length;
      if (alength !== b.length) {
        return false;
      }
      for (i = 0; 0 <= alength ? i < alength : i > alength; 0 <= alength ? i++ : i--) {
        if (!this.equals(a[i], b[i])) {
          return false;
        }
      }
      return true;
    };
    jsondiff.prototype.object_equals = function(a, b) {
      var key;
      for (key in a) {
        if (!__hasProp.call(a, key)) continue;
        if (!(key in b)) {
          return false;
        }
        if (!this.equals(a[key], b[key])) {
          return false;
        }
      }
      for (key in b) {
        if (!__hasProp.call(b, key)) continue;
        if (!(key in a)) {
          return false;
        }
      }
      return true;
    };
    jsondiff.prototype._common_prefix = function(a, b) {
      var i, minlen;
      minlen = Math.min(a.length, b.length);
      for (i = 0; 0 <= minlen ? i < minlen : i > minlen; 0 <= minlen ? i++ : i--) {
        if (!this.equals(a[i], b[i])) {
          return i;
        }
      }
      return minlen;
    };
    jsondiff.prototype._common_suffix = function(a, b) {
      var i, lena, lenb, minlen;
      lena = a.length;
      lenb = b.length;
      minlen = Math.min(a.length, b.length);
      if (minlen === 0) {
        return 0;
      }
      for (i = 0; 0 <= minlen ? i < minlen : i > minlen; 0 <= minlen ? i++ : i--) {
        if (!this.equals(a[lena - i - 1], b[lenb - i - 1])) {
          return i;
        }
      }
      return minlen;
    };
    jsondiff.prototype.list_diff = function(a, b) {
      var diffs, i, lena, lenb, maxlen, prefix_len, suffix_len;
      diffs = {};
      lena = a.length;
      lenb = b.length;
      prefix_len = this._common_prefix(a, b);
      suffix_len = this._common_suffix(a, b);
      a = a.slice(prefix_len, lena - suffix_len);
      b = b.slice(prefix_len, lenb - suffix_len);
      lena = a.length;
      lenb = b.length;
      maxlen = Math.max(lena, lenb);
      for (i = 0; 0 <= maxlen ? i <= maxlen : i >= maxlen; 0 <= maxlen ? i++ : i--) {
        if (i < lena && i < lenb) {
          if (!this.equals(a[i], b[i])) {
            diffs[i + prefix_len] = this.diff(a[i], b[i]);
          }
        } else if (i < lena) {
          diffs[i + prefix_len] = {
            'o': '-'
          };
        } else if (i < lenb) {
          diffs[i + prefix_len] = {
            'o': '+',
            'v': b[i]
          };
        }
      }
      return diffs;
    };
    jsondiff.prototype.object_diff = function(a, b) {
      var diffs, key;
      diffs = {};
      if (!(a != null) || !(b != null)) {
        return {};
      }
      for (key in a) {
        if (!__hasProp.call(a, key)) continue;
        if (key in b) {
          if (!this.equals(a[key], b[key])) {
            diffs[key] = this.diff(a[key], b[key]);
          }
        } else {
          diffs[key] = {
            'o': '-'
          };
        }
      }
      for (key in b) {
        if (!__hasProp.call(b, key)) continue;
        if (!(key in a)) {
          diffs[key] = {
            'o': '+',
            'v': b[key]
          };
        }
      }
      return diffs;
    };
    jsondiff.prototype.diff = function(a, b) {
      var diffs, typea;
      if (this.equals(a, b)) {
        return {};
      }
      typea = this.typeOf(a);
      if (typea !== this.typeOf(b)) {
        return {
          'o': 'r',
          'v': b
        };
      }
      switch (typea) {
        case 'boolean':
          return {
            'o': 'r',
            'v': b
          };
        case 'number':
          return {
            'o': 'r',
            'v': b
          };
        case 'array':
          return {
            'o': 'r',
            'v': b
          };
        case 'object':
          return {
            'o': 'O',
            'v': this.object_diff(a, b)
          };
        case 'string':
          diffs = jsondiff.dmp.diff_main(a, b);
          if (diffs.length > 2) {
            jsondiff.dmp.diff_cleanupEfficiency(diffs);
          }
          if (diffs.length > 0) {
            return {
              'o': 'd',
              'v': jsondiff.dmp.diff_toDelta(diffs)
            };
          }
      }
      return {};
    };
    jsondiff.prototype.apply_list_diff = function(s, diffs) {
      var deleted, dmp_diffs, dmp_patches, dmp_result, index, indexes, key, op, patched, s_index, shift, x, _i, _len, _ref, _ref2;
      patched = this.deepCopy(s);
      indexes = [];
      deleted = [];
      for (key in diffs) {
        if (!__hasProp.call(diffs, key)) continue;
        indexes.push(key);
        indexes.sort();
      }
      for (_i = 0, _len = indexes.length; _i < _len; _i++) {
        index = indexes[_i];
        op = diffs[index];
        shift = ((function() {
          var _j, _len2, _results;
          _results = [];
          for (_j = 0, _len2 = deleted.length; _j < _len2; _j++) {
            x = deleted[_j];
            if (x <= index) {
              _results.push(x);
            }
          }
          return _results;
        })()).length;
        s_index = index - shift;
        switch (op['o']) {
          case '+':
            [].splice.apply(patched, [s_index, s_index - s_index + 1].concat(_ref = op['v'])), _ref;
            break;
          case '-':
            [].splice.apply(patched, [s_index, s_index - s_index + 1].concat(_ref2 = [])), _ref2;
            deleted[deleted.length] = s_index;
            break;
          case 'r':
            patched[s_index] = op['v'];
            break;
          case 'I':
            patched[s_index] += op['v'];
            break;
          case 'L':
            patched[s_index] = this.apply_list_diff(patched[s_index], op['v']);
            break;
          case 'O':
            patched[s_index] = this.apply_object_diff(patched[s_index], op['v']);
            break;
          case 'd':
            dmp_diffs = jsondiff.dmp.diff_fromDelta(patched[s_index], op['v']);
            dmp_patches = jsondiff.dmp.patch_make(patched[s_index], dmp_diffs);
            dmp_result = jsondiff.dmp.patch_apply(dmp_patches, patched[s_index]);
            patched[s_index] = dmp_result[0];
        }
      }
      return patched;
    };
    jsondiff.prototype.apply_object_diff = function(s, diffs) {
      var dmp_diffs, dmp_patches, dmp_result, key, op, patched;
      patched = this.deepCopy(s);
      for (key in diffs) {
        if (!__hasProp.call(diffs, key)) continue;
        op = diffs[key];
        switch (op['o']) {
          case '+':
            patched[key] = op['v'];
            break;
          case '-':
            delete patched[key];
            break;
          case 'r':
            patched[key] = op['v'];
            break;
          case 'I':
            patched[key] += op['v'];
            break;
          case 'L':
            patched[key] = this.apply_list_diff(patched[key], op['v']);
            break;
          case 'O':
            patched[key] = this.apply_object_diff(patched[key], op['v']);
            break;
          case 'd':
            dmp_diffs = jsondiff.dmp.diff_fromDelta(patched[key], op['v']);
            dmp_patches = jsondiff.dmp.patch_make(patched[key], dmp_diffs);
            dmp_result = jsondiff.dmp.patch_apply(dmp_patches, patched[key]);
            patched[key] = dmp_result[0];
        }
      }
      return patched;
    };
    jsondiff.prototype.apply_object_diff_with_offsets = function(s, diffs, field, offsets) {
      var dmp_diffs, dmp_patches, dmp_result, key, op, patched;
      patched = this.deepCopy(s);
      for (key in diffs) {
        if (!__hasProp.call(diffs, key)) continue;
        op = diffs[key];
        switch (op['o']) {
          case '+':
            patched[key] = op['v'];
            break;
          case '-':
            delete patched[key];
            break;
          case 'r':
            patched[key] = op['v'];
            break;
          case 'I':
            patched[key] += op['v'];
            break;
          case 'L':
            patched[key] = this.apply_list_diff(patched[key], op['v']);
            break;
          case 'O':
            patched[key] = this.apply_object_diff(patched[key], op['v']);
            break;
          case 'd':
            dmp_diffs = jsondiff.dmp.diff_fromDelta(patched[key], op['v']);
            dmp_patches = jsondiff.dmp.patch_make(patched[key], dmp_diffs);
            if (key === field) {
              patched[key] = this.patch_apply_with_offsets(dmp_patches, patched[key], offsets);
            } else {
              dmp_result = jsondiff.dmp.patch_apply(dmp_patches, patched[key]);
              patched[key] = dmp_result[0];
            }
        }
      }
      return patched;
    };
    jsondiff.prototype.transform_list_diff = function(ad, bd, s) {
      var ad_new, b_deletes, b_inserts, diff, index, op, shift_l, shift_r, sindex, x;
      ad_new = {};
      b_inserts = [];
      b_deletes = [];
      for (index in bd) {
        if (!__hasProp.call(bd, index)) continue;
        op = bd[index];
        if (op['o'] === '+') {
          b_inserts.push(index);
        }
        if (op['o'] === '-') {
          b_deletes.push(index);
        }
      }
      for (index in ad) {
        if (!__hasProp.call(ad, index)) continue;
        op = ad[index];
        shift_r = [
          (function() {
            var _i, _len, _results;
            _results = [];
            for (_i = 0, _len = b_inserts.length; _i < _len; _i++) {
              x = b_inserts[_i];
              if (x <= index) {
                _results.push(x);
              }
            }
            return _results;
          })()
        ].length;
        shift_l = [
          (function() {
            var _i, _len, _results;
            _results = [];
            for (_i = 0, _len = b_deletes.length; _i < _len; _i++) {
              x = b_deletes[_i];
              if (x <= index) {
                _results.push(x);
              }
            }
            return _results;
          })()
        ].length;
        index = index + shift_r - shift_l;
        sindex = String(index);
        ad_new[sindex] = op;
        if (index in bd) {
          if (op['o'] === '+' && bd.index['o'] === '+') {
            continue;
          } else if (op['o'] === '-' && bd.index['o'] === '-') {
            delete ad_new[sindex];
          } else {
            diff = this.transform_object_diff({
              sindex: op
            }, {
              sindex: bd.index
            }, s);
            ad_new[sindex] = diff[sindex];
          }
        }
      }
      return ad_new;
    };
    jsondiff.prototype.transform_object_diff = function(ad, bd, s) {
      var a_patches, ab_text, ad_new, aop, b_patches, b_text, bop, dmp_diffs, dmp_patches, dmp_result, key, sk, _ref;
      ad_new = this.deepCopy(ad);
      for (key in ad) {
        if (!__hasProp.call(ad, key)) continue;
        aop = ad[key];
        if (!(key in bd)) {
          continue;
        }
        sk = s[key];
        bop = bd[key];
        if (aop['o'] === '+' && bop['o'] === '+') {
          if (this.equals(aop['v'], bop['v'])) {
            delete ad_new[key];
          } else {
            ad_new[key] = this.diff(bop['v'], aop['v']);
          }
        } else if (aop['o'] === '-' && bop['o'] === '-') {
          delete ad_new[key];
        } else if (bop['o'] === '-' && ((_ref = aop['o']) === 'O' || _ref === 'L' || _ref === 'I' || _ref === 'd')) {
          ad_new[key] = {
            'o': '+'
          };
          if (aop['o'] === 'O') {
            ad_new[key]['v'] = this.apply_object_diff(sk, aop['v']);
          } else if (aop['o'] === 'L') {
            ad_new[key]['v'] = this.apply_list_diff(sk, aop['v']);
          } else if (aop['o'] === 'I') {
            ad_new[key]['v'] = sk + aop['v'];
          } else if (aop['o'] === 'd') {
            dmp_diffs = jsondiff.dmp.diff_fromDelta(sk, aop['v']);
            dmp_patches = jsondiff.dmp.patch_make(sk, dmp_diffs);
            dmp_result = jsondiff.dmp.patch_apply(dmp_patches, sk);
            ad_new[key]['v'] = dmp_result[0];
          }
        } else if (aop['o'] === 'O' && bop['o'] === 'O') {
          ad_new[key] = {
            'o': 'O',
            'v': this.transform_object_diff(aop['v'], bop['v'], sk)
          };
        } else if (aop['o'] === 'L' && bop['o'] === 'L') {
          ad_new[key] = {
            'o': 'O',
            'v': this.transform_list_diff(aop['v'], bop['v'], sk)
          };
        } else if (aop['o'] === 'd' && bop['o'] === 'd') {
          delete ad_new[key];
          a_patches = jsondiff.dmp.patch_make(sk, jsondiff.dmp.diff_fromDelta(sk, aop['v']));
          b_patches = jsondiff.dmp.patch_make(sk, jsondiff.dmp.diff_fromDelta(sk, bop['v']));
          b_text = (jsondiff.dmp.patch_apply(b_patches, sk))[0];
          ab_text = (jsondiff.dmp.patch_apply(a_patches, b_text))[0];
          if (ab_text !== b_text) {
            dmp_diffs = jsondiff.dmp.diff_main(b_text, ab_text);
            if (dmp_diffs.length > 2) {
              jsondiff.dmp.diff_cleanupEfficiency(dmp_diffs);
            }
            if (dmp_diffs.length > 0) {
              ad_new[key] = {
                'o': 'd',
                'v': jsondiff.dmp.diff_toDelta(dmp_diffs)
              };
            }
          }
        }
        return ad_new;
      }
    };
    jsondiff.prototype.patch_apply_with_offsets = function(patches, text, offsets) {};
    jsondiff.prototype.patch_apply_with_offsets = function(patches, text, offsets) {
    if (patches.length == 0) {
      return text;
    }

    // Deep copy the patches so that no changes are made to originals.
    patches = jsondiff.dmp.patch_deepCopy(patches);
    var nullPadding = jsondiff.dmp.patch_addPadding(patches);
    text = nullPadding + text + nullPadding;

    jsondiff.dmp.patch_splitMax(patches);
    // delta keeps track of the offset between the expected and actual location
    // of the previous patch.  If there are patches expected at positions 10 and
    // 20, but the first patch was found at 12, delta is 2 and the second patch
    // has an effective expected position of 22.
    var delta = 0;
    for (var x = 0; x < patches.length; x++) {
      var expected_loc = patches[x].start2 + delta;
      var text1 = jsondiff.dmp.diff_text1(patches[x].diffs);
      var start_loc;
      var end_loc = -1;
      if (text1.length > jsondiff.dmp.Match_MaxBits) {
        // patch_splitMax will only provide an oversized pattern in the case of
        // a monster delete.
        start_loc = jsondiff.dmp.match_main(text,
            text1.substring(0, jsondiff.dmp.Match_MaxBits), expected_loc);
        if (start_loc != -1) {
          end_loc = jsondiff.dmp.match_main(text,
              text1.substring(text1.length - jsondiff.dmp.Match_MaxBits),
              expected_loc + text1.length - jsondiff.dmp.Match_MaxBits);
          if (end_loc == -1 || start_loc >= end_loc) {
            // Can't find valid trailing context.  Drop this patch.
            start_loc = -1;
          }
        }
      } else {
        start_loc = jsondiff.dmp.match_main(text, text1, expected_loc);
      }
      if (start_loc == -1) {
        // No match found.  :(
        /*
        if (mobwrite.debug) {
          window.console.warn('Patch failed: ' + patches[x]);
        }
        */
        // Subtract the delta for this failed patch from subsequent patches.
        delta -= patches[x].length2 - patches[x].length1;
      } else {
        // Found a match.  :)
        /*
        if (mobwrite.debug) {
          window.console.info('Patch OK.');
        }
        */
        delta = start_loc - expected_loc;
        var text2;
        if (end_loc == -1) {
          text2 = text.substring(start_loc, start_loc + text1.length);
        } else {
          text2 = text.substring(start_loc, end_loc + jsondiff.dmp.Match_MaxBits);
        }
        // Run a diff to get a framework of equivalent indices.
        var diffs = jsondiff.dmp.diff_main(text1, text2, false);
        if (text1.length > jsondiff.dmp.Match_MaxBits &&
            jsondiff.dmp.diff_levenshtein(diffs) / text1.length >
            jsondiff.dmp.Patch_DeleteThreshold) {
          // The end points match, but the content is unacceptably bad.
          /*
          if (mobwrite.debug) {
            window.console.warn('Patch contents mismatch: ' + patches[x]);
          }
          */
        } else {
          var index1 = 0;
          var index2;
          for (var y = 0; y < patches[x].diffs.length; y++) {
            var mod = patches[x].diffs[y];
            if (mod[0] !== DIFF_EQUAL) {
              index2 = jsondiff.dmp.diff_xIndex(diffs, index1);
            }
            if (mod[0] === DIFF_INSERT) {  // Insertion
              text = text.substring(0, start_loc + index2) + mod[1] +
                     text.substring(start_loc + index2);
              for (var i = 0; i < offsets.length; i++) {
                if (offsets[i] + nullPadding.length > start_loc + index2) {
                  offsets[i] += mod[1].length;
                }
              }
            } else if (mod[0] === DIFF_DELETE) {  // Deletion
              var del_start = start_loc + index2;
              var del_end = start_loc + jsondiff.dmp.diff_xIndex(diffs,
                  index1 + mod[1].length);
              text = text.substring(0, del_start) + text.substring(del_end);
              for (var i = 0; i < offsets.length; i++) {
                if (offsets[i] + nullPadding.length > del_start) {
                  if (offsets[i] + nullPadding.length < del_end) {
                    offsets[i] = del_start - nullPadding.length;
                  } else {
                    offsets[i] -= del_end - del_start;
                  }
                }
              }
            }
            if (mod[0] !== DIFF_DELETE) {
              index1 += mod[1].length;
            }
          }
        }
      }
    }
    // Strip the padding off.
    text = text.substring(nullPadding.length, text.length - nullPadding.length);
    return text;
  };
    return jsondiff;
  })();
  window['jsondiff'] = jsondiff;
}).call(this);
(function() {
  var simperium,
    __bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; },
    __hasProp = Object.prototype.hasOwnProperty,
    __indexOf = Array.prototype.indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

  simperium = (function() {

    simperium.prototype.S4 = function() {
      return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
    };

    simperium.prototype._time = function() {
      var d;
      d = new Date();
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()) / 1000;
    };

    simperium.prototype.supports_html5_storage = function() {
      try {
        return 'localStorage' in window && window['localStorage'] !== null;
      } catch (error) {
        return false;
      }
    };

    simperium.prototype._save_meta = function() {
      if (!this.supports_html5_storage()) return false;
      try {
        localStorage.setItem("" + this.namespace + "/ccid", this.data.ccid);
        localStorage.setItem("" + this.namespace + "/last_cv", this.data.last_cv);
      } catch (error) {
        return false;
      }
      return true;
    };

    simperium.prototype._load_meta = function() {
      var _base, _base2, _ref;
      if (!this.supports_html5_storage()) return;
      this.data.ccid = localStorage.getItem("" + this.namespace + "/ccid");
      if ((_base = this.data).ccid == null) _base.ccid = 1;
      this.data.last_cv = localStorage.getItem("" + this.namespace + "/last_cv");
      return (_ref = (_base2 = this.data).last_cv) != null ? _ref : _base2.last_cv = 0;
    };

    simperium.prototype._verify = function(data) {
      if (!('object' in data) || !('version' in data)) return false;
      if (this.jd.entries(data['object']) === 0) {
        if (this.jd.entries(data['last']) > 0) {
          return true;
        } else {
          return false;
        }
      } else {
        if (!(data['version'] != null)) return false;
      }
      return true;
    };

    simperium.prototype._load_data = function() {
      var data, datastr, id, key, loaded, p_len, prefix;
      if (!this.supports_html5_storage()) return;
      prefix = "" + this.namespace + "/e/";
      p_len = prefix.length;
      loaded = 0;
      for (key in localStorage) {
        if (!__hasProp.call(localStorage, key)) continue;
        datastr = localStorage[key];
        if (key.substr(0, p_len) === prefix) {
          id = key.substr(p_len, key.length - p_len);
          try {
            data = JSON.parse(datastr);
          } catch (error) {
            data = null;
          }
          if (!(data != null)) continue;
          if (this._verify(data)) {
            if ('check' in data) delete data['check'];
            this.data.store[id] = data;
            loaded = loaded + 1;
          } else {
            console.log("ignoring CORRUPT data: " + (JSON.stringify(data)));
          }
        }
      }
      return loaded;
    };

    simperium.prototype._save_entity = function(id) {
      var datastr, key, ret_data, store_data;
      key = "" + this.namespace + "/e/" + id;
      store_data = this.data.store[id];
      datastr = JSON.stringify(store_data);
      try {
        localStorage.setItem(key, datastr);
      } catch (error) {
        return false;
      }
      ret_data = JSON.parse(localStorage.getItem(key));
      if (this.jd.equals(store_data, ret_data)) {
        return true;
      } else {
        return false;
      }
      return true;
    };

    simperium.prototype._remove_entity = function(id) {
      var key;
      key = "" + this.namespace + "/e/" + id;
      return localStorage.removeItem(key);
    };

    simperium.prototype._get_hash_params = function() {
      var hash_params, hashstring, r, results;
      hash_params = {};
      hashstring = window.location.hash.substring(1);
      r = /([^&;=]+)=?([^&;]*)/g;
      while (results = r.exec(hashstring)) {
        hash_params[decodeURIComponent(results[1])] = decodeURIComponent(results[2]);
      }
      return hash_params;
    };

    simperium.prototype._remove_hash = function() {
      if ('pushState' in window.history) {
        return window.history.pushState("", document.title, window.location.pathname);
      } else {
        return window.location.hash = '';
      }
    };

    simperium.prototype.login = function() {
      var error, hash;
      if (window.location.search.indexOf("error=") !== -1) {
        error = true;
      } else {
        error = false;
      }
      hash = this._get_hash_params();
      this._remove_hash();
      if ('access_token' in hash) {
        this.auth_token = hash['access_token'];
        console.log("" + this.listname + ": login() got access token: " + this.auth_token);
        return true;
      } else {
        if (!('client_id' in this.options)) {
          console.log("no client id, cant authenticate");
        } else if (error === true) {
          console.log("" + this.listname + ": error authorizing client, not logging in");
        } else {
          console.log("redirecting to auth_url = " + this.auth_url);
          window.location = this.auth_url;
        }
      }
      return false;
    };

    function simperium(appid, listname, options) {
      var auth_scheme, scheme, store_user;
      this.appid = appid;
      this.listname = listname;
      this.options = options;
      this._restoreCursor = __bind(this._restoreCursor, this);
      this._captureCursor = __bind(this._captureCursor, this);
      this.on_changes = __bind(this.on_changes, this);
      this.retrieve_changes = __bind(this.retrieve_changes, this);
      this._send_changes = __bind(this._send_changes, this);
      this._queue_change = __bind(this._queue_change, this);
      this._make_change = __bind(this._make_change, this);
      this.update = __bind(this.update, this);
      this._check_update = __bind(this._check_update, this);
      this._notify_client = __bind(this._notify_client, this);
      this._socket_message = __bind(this._socket_message, this);
      this._socket_disconnected = __bind(this._socket_disconnected, this);
      this._socket_connected = __bind(this._socket_connected, this);
      this._socket_reconnected = __bind(this._socket_reconnected, this);
      this._socket_connecting = __bind(this._socket_connecting, this);
      this._index_loaded = __bind(this._index_loaded, this);
      this.on_entity_version = __bind(this.on_entity_version, this);
      this.get_version = __bind(this.get_version, this);
      this.load_versions = __bind(this.load_versions, this);
      this.on_index_error = __bind(this.on_index_error, this);
      this.on_index = __bind(this.on_index, this);
      this.on_index_page = __bind(this.on_index_page, this);
      this._refresh_store = __bind(this._refresh_store, this);
      this.start = __bind(this.start, this);
      this.initialize_client = __bind(this.initialize_client, this);
      this.get_all_data = __bind(this.get_all_data, this);
      this.get = __bind(this.get, this);
      this._authorized = __bind(this._authorized, this);
      this.login = __bind(this.login, this);
      this._remove_entity = __bind(this._remove_entity, this);
      this._save_entity = __bind(this._save_entity, this);
      this._load_data = __bind(this._load_data, this);
      this._verify = __bind(this._verify, this);
      this._load_meta = __bind(this._load_meta, this);
      this.jd = new jsondiff();
      this.dmp = jsondiff.dmp;
      this.auth_token = null;
      this.options = this.options || {};
      this.namespace = "" + this.appid + "/" + this.listname;
      if (!('host' in this.options)) this.options['host'] = 'api.simperium.com';
      if (!('port' in this.options)) this.options['port'] = 80;
      if (!('auth_host' in this.options)) {
        this.options['auth_host'] = 'stargate.simperium.com';
      }
      if ('token' in this.options) this.auth_token = this.options['token'];
      if (!('stream_index' in this.options)) this.options['stream_index'] = false;
      this.initialized = false;
      this.authorized = false;
      if (this.options['host'].indexOf("simperium.com") !== -1) {
        scheme = "https";
      } else {
        scheme = "http";
      }
      if (this.options['auth_host'].indexOf("simperium.com") !== -1) {
        auth_scheme = "https";
      } else {
        auth_scheme = "http";
      }
      this.options['port'] = parseInt(this.options['port']);
      if (this.options['port'] !== 80 && this.options['port'] !== 443) {
        this.dataurl = "" + scheme + "://" + this.options['host'] + ":" + this.options['port'] + "/" + this.appid + "/" + this.listname + "/data";
      } else {
        this.dataurl = "" + scheme + "://" + this.options['host'] + "/" + this.appid + "/" + this.listname + "/data";
      }
      this.auth_url = "" + auth_scheme + "://" + this.options['auth_host'] + "/app/" + this.appid + "/authorize?response_type=token&client_id=" + this.options['client_id'] + "&redirect_uri=" + window.location;
      console.log("" + this.listname + ": dataurl: " + this.dataurl);
      this.clientid = null;
      if (!(this.clientid != null)) {
        this.clientid = "smp-002-" + this.S4() + this.S4() + this.S4();
        localStorage.setItem("" + this.appid + "/clientid", this.clientid);
      }
      this.data = {
        ccid: 1,
        last_cv: 0,
        store: {}
      };
      this._send_queue = [];
      if (!('nostore' in this.options)) {
        if ('username' in this.options) {
          store_user = localStorage.getItem("" + this.namespace + "/username");
          if ((store_user != null) && !(store_user === this.options['username'])) {
            localStorage.clear();
          }
        }
        this._load_meta();
        this.loaded = this._load_data();
        console.log("" + this.listname + ": localstorage loaded " + this.loaded + " entities");
      } else {
        console.log("" + this.listname + ": not loading from localstorage");
        this.loaded = 0;
      }
      this.notify_index = {};
      this.cb_notify = null;
      this.cb_notify_version = null;
      this.cb_get_data = null;
      this.cb_initialized = null;
    }

    simperium.prototype._authorized = function(username) {
      var store_user;
      this.authorized = true;
      this.authorized_user = username;
      store_user = localStorage.getItem("" + this.namespace + "/username");
      if ((store_user != null) && !(store_user === username)) {
        console.log("user changed, clearing localStorage: " + username + " != stored:" + store_user);
        this._send_queue = [];
        localStorage.clear();
        return localStorage.setItem("" + this.namespace + "/username", username);
      }
    };

    simperium.prototype.set_notify = function(notify_callback) {
      return this.cb_notify = notify_callback;
    };

    simperium.prototype.set_notify_version = function(notify_version_callback) {
      return this.cb_notify_version = notify_version_callback;
    };

    simperium.prototype.set_get_data = function(get_data_callback) {
      return this.cb_get_data = get_data_callback;
    };

    simperium.prototype.set_initialized = function(initialized_callback) {
      return this.cb_initialized = initialized_callback;
    };

    simperium.prototype.get = function(id) {
      if ((this.data.store != null) && (this.data.store[id] != null)) {
        return this.jd.deepCopy(this.data.store[id]['object']);
      }
      return null;
    };

    simperium.prototype.get_all_data = function() {
      var all_data, data, entities, id, s_data, _ref;
      all_data = {};
      entities = 0;
      if (this.data.store != null) {
        _ref = this.data.store;
        for (id in _ref) {
          if (!__hasProp.call(_ref, id)) continue;
          s_data = _ref[id];
          if (s_data['last'] != null) {
            data = this.jd.deepCopy(s_data['last']);
          } else {
            data = this.jd.deepCopy(s_data['object']);
          }
          all_data[id] = data;
          entities = entities + 1;
        }
      }
      console.log("" + this.listname + ": get_all_data returned " + entities);
      return all_data;
    };

    simperium.prototype.initialize_client = function() {
      var data, id, notifies, notify_func, s_data, _ref, _ref2,
        _this = this;
      console.log("" + this.listname + ": initialize_client called");
      if ((this.cb_notify != null) && (this.data.store != null)) {
        notifies = 0;
        _ref = this.data.store;
        for (id in _ref) {
          if (!__hasProp.call(_ref, id)) continue;
          s_data = _ref[id];
          notifies += 1;
        }
        console.log("" + this.listname + ": checking notifies " + notifies);
        _ref2 = this.data.store;
        for (id in _ref2) {
          if (!__hasProp.call(_ref2, id)) continue;
          s_data = _ref2[id];
          if (this.notify_index[id] === true) {
            notifies -= 1;
            continue;
          }
          if ((s_data['last'] != null) && this.jd.entries(s_data['last']) > 0) {
            console.log("" + this.listname + ": NOTIFY using s_data.last for " + id);
            console.log(s_data);
            data = this.jd.deepCopy(s_data['last']);
            if (this.sio.connected) this._check_update(id);
          } else {
            data = this.jd.deepCopy(s_data['object']);
          }
          notify_func = function(id, data) {
            _this.cb_notify(id, data, null);
            notifies -= 1;
            if (notifies === 0 && (_this.cb_initialized != null)) {
              return _this.cb_initialized();
            }
          };
          setTimeout((function(id, data) {
            return function() {
              return notify_func(id, data);
            };
          })(id, data));
        }
        if (notifies === 0 && (this.cb_initialized != null)) {
          console.log("" + this.listname + " no scheduled notifications, initializing");
          return this.cb_initialized();
        }
      }
    };

    simperium.prototype.start = function() {
      var port, reconnect, secure, socket_opts;
      console.log("" + this.listname + ": start()");
      if (!this.auth_token || this.auth_token === "none" || this.auth_token === "None") {
        console.log("" + this.listname + ": no auth token available, cannot start auth_token:" + this.auth_token);
        return;
      }
      if ('reconnect' in this.options && this.options['reconnect'] === true) {
        reconnect = true;
      } else {
        reconnect = false;
      }
      if (this.options['host'].indexOf("simperium.com") !== -1) {
        secure = true;
        port = 443;
      } else {
        secure = false;
        port = this.options['port'];
      }
      socket_opts = {
        port: port,
        secure: secure,
        rememberTransport: false,
        reconnect: true,
        resource: "change:" + this.clientid + ":" + this.appid + "/" + this.listname + "/" + this.auth_token,
        reconnectionDelay: 500,
        transports: ['websocket', 'xhr-polling', 'xhr-multipart']
      };
      if (!('update_delay' in this.options)) this.options['update_delay'] = 0;
      console.log("" + this.listname + " connect to " + this.options['host'] + " - socket.io opts:");
      console.log(socket_opts);
      this.sio = new io.Socket(this.options['host'], socket_opts);
      this.sio.on('connect', this._socket_connected);
      this.sio.on('message', this._socket_message);
      this.sio.on('reconnect', this._socket_reconnected);
      this.sio.on('disconnect', this._socket_disconnected);
      this.sio.on('connecting', this._socket_connecting);
      return this.sio.connect();
    };

    simperium.prototype._refresh_store = function() {
      console.log("" + this.listname + ": _refresh_store(): loading index: dataurl: " + this.dataurl);
      this.sio.send("i:1:::40");
      this.irequest_time = Date.now();
    };

    simperium.prototype.on_index_page = function(response) {
      var elapsed, item, now, _i, _len, _ref,
        _this = this;
      now = Date.now();
      elapsed = now - this.irequest_time;
      console.log("" + this.listname + ": index response time: " + elapsed);
      console.log("" + this.listname + ": on_index_page(): index page received, current= " + response['current']);
      console.log(response);
      _ref = response['index'];
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        item = _ref[_i];
        setTimeout((function(item) {
          return function() {
            return _this.on_entity_version(item['d'], item['id'], item['v']);
          };
        })(item));
      }
      if (!('mark' in response)) {
        if ('current' in response) {
          this.data.last_cv = response['current'];
          this._save_meta();
        } else {
          this.data.last_cv = 0;
        }
        return this._index_loaded();
      } else {
        console.log("" + this.listname + ": index last process time: " + (Date.now() - now));
        this.sio.send("i:1:" + response['mark'] + "::100");
        return this.irequest_time = Date.now();
      }
    };

    simperium.prototype.on_index = function(response) {
      var data, key, loading, version, _ref, _ref2,
        _this = this;
      console.log("" + this.listname + ": on_index(): index received, cv = " + response['cv']);
      console.log(response);
      loading = 0;
      if (response['cv'] != null) {
        this.data.last_cv = response['cv'];
        this._save_meta();
      } else {
        this.data.last_cv = 0;
      }
      this.loading_index = {};
      _ref = response['index'];
      for (key in _ref) {
        if (!__hasProp.call(_ref, key)) continue;
        version = _ref[key];
        this.loading_index[key] = false;
        if ((this.data.store[key] != null) && this.data.store[key]['version'] === version) {
          this.loading_index[key] = true;
          continue;
        }
        loading = loading + 1;
        console.log("" + this.listname + ": retrieving " + key + "/" + version);
        this.sio.send("e:" + key + "." + version);
      }
      _ref2 = this.data.store;
      for (key in _ref2) {
        if (!__hasProp.call(_ref2, key)) continue;
        data = _ref2[key];
        if (!(response['index'][key] != null)) {
          delete this.data.store[key];
          this._remove_entity(key);
          setTimeout((function(key) {
            return function() {
              return _this.cb_notify(key, null, null);
            };
          })(key));
          console.log("" + this.listname + " deleting " + key + " no longer in index");
        }
      }
      console.log("" + this.listname + ": entries in loading_index = " + (this.jd.entries(this.loading_index)) + ", loading versions: " + loading);
      if (this.jd.entries(this.loading_index) === 0 || loading === 0) {
        console.log("" + this.listname + ": nothing to load, index loaded");
        return this._index_loaded();
      }
    };

    simperium.prototype.on_index_error = function() {
      var _this = this;
      console.log("" + this.listname + ": index doesnt exist or other error");
      if (!this.sio.connected) {
        return setTimeout(function() {
          return _this.sio.connect();
        });
      }
    };

    simperium.prototype.load_versions = function(id, versions) {
      var min, v, _ref, _results;
      if (!(id in this.data.store)) return false;
      min = Math.max(this.data.store[id]['version'] - (versions + 1), 1);
      _results = [];
      for (v = min, _ref = this.data.store[id]['version'] - 1; min <= _ref ? v <= _ref : v >= _ref; min <= _ref ? v++ : v--) {
        console.log("" + this.listname + ": loading version " + id + "." + v);
        _results.push(this.sio.send("e:" + id + "." + v));
      }
      return _results;
    };

    simperium.prototype.get_version = function(id, version) {
      var evkey;
      evkey = "" + id + "." + version;
      return this.sio.send("e:" + evkey);
    };

    simperium.prototype.on_entity_version = function(data, id, version) {
      var data_copy, to_load, _ref;
      console.log("" + this.listname + ": on_entity_version(" + data + ", " + id + ", " + version + ")");
      data_copy = null;
      if (data != null) data_copy = this.jd.deepCopy(data);
      if (id in this.data.store && version < this.data.store[id]['version']) {
        if (this.cb_notify_version) {
          return this.cb_notify_version(id, data_copy, version);
        }
      } else {
        this.data.store[id] = {
          'id': id,
          'object': data,
          'version': parseInt(version)
        };
        if (this.options['stream_index'] === true) {
          this.cb_notify(id, data_copy, version);
          this.notify_index[id] = true;
        }
        if (this.loading_index != null) {
          this.loading_index[id] = true;
          to_load = 0;
          _ref = this.loading_index;
          for (id in _ref) {
            if (!__hasProp.call(_ref, id)) continue;
            if (this.loading_index[id] === false) to_load++;
          }
          if (to_load > 0) {
            return console.log("loading left: " + to_load);
          } else {
            return this._index_loaded();
          }
        }
      }
    };

    simperium.prototype._index_loaded = function() {
      var _this = this;
      console.log("" + this.listname + ": index loaded, initialized: " + this.initialized + ", connected: " + this.sio.connected);
      if (this.initialized === false) this.initialize_client();
      this.initialized = true;
      if (this.sio.connected === !true) {
        return setTimeout(function() {
          return _this.sio.connect();
        });
      } else {
        return this.retrieve_changes();
      }
    };

    simperium.prototype._socket_connecting = function(transport_type) {
      return console.log("" + this.listname + ": connecting: " + transport_type);
    };

    simperium.prototype._socket_reconnected = function() {
      return console.log("" + this.listname + ": reconnected");
    };

    simperium.prototype._socket_connected = function() {
      return console.log("" + this.listname + ": connected");
    };

    simperium.prototype._socket_disconnected = function() {
      return console.log("" + this.listname + ": disconnected");
    };

    simperium.prototype._socket_message = function(data) {
      var changes, entity, entitydata, evkey, id, key, key_end, s_data, user, version, _ref,
        _this = this;
      if (data.substr(0, 5) === "auth:") {
        user = data.substr(5);
        if (user.substr(0, 7) === "expired") {
          console.log("" + this.listname + ": auth expired");
          return this.sio.disconnect();
        } else {
          this._authorized(user);
          if (!this.initialized) {
            setTimeout(function() {
              return _this._refresh_store();
            });
            return;
            if (this.data.last_cv === 0 || this.data.last_cv === "0") {
              return setTimeout(function() {
                return _this._refresh_store();
              });
            } else {
              return setTimeout(function() {
                return _this.initialize_client();
              });
            }
          } else {
            _ref = this.data.store;
            for (id in _ref) {
              if (!__hasProp.call(_ref, id)) continue;
              s_data = _ref[id];
              this._check_update(id);
            }
            setTimeout(function() {
              return _this._send_changes();
            });
            return setTimeout(function() {
              return _this.retrieve_changes();
            });
          }
        }
      } else if (data.substr(0, 4) === "cv:?") {
        console.log("" + this.listname + ": cv out of sync, refreshing index");
        return setTimeout(function() {
          return _this._refresh_store();
        });
      } else if (data.substr(0, 2) === "c:") {
        changes = JSON.parse(data.substr(2));
        if (this.data.last_cv === "0" && changes.length === 0 && !this.cv_check) {
          this.cv_check = true;
          this._refresh_store();
        }
        return this.on_changes(changes);
      } else if (data.substr(0, 2) === "u:") {
        this.user = JSON.parse(data.substr(2));
        if (this.data.last_cv === 0 || this.data.last_cv === "0") {
          return setTimeout(function() {
            return _this._refresh_store();
          });
        } else {
          return setTimeout(function() {
            return _this.retrieve_changes();
          });
        }
      } else if (data.substr(0, 2) === "i:") {
        console.log("" + this.listname + ": index received");
        return this.on_index(JSON.parse(data.substr(2)));
      } else if (data.substr(0, 3) === "ix:") {
        console.log("" + this.listname + ":  index msg received: " + (Date.now() - this.irequest_time));
        return this.on_index_page(JSON.parse(data.substr(3)));
      } else if (data.substr(0, 2) === "e:") {
        key_end = data.indexOf("\n");
        evkey = data.substr(2, key_end - 2);
        version = evkey.substr(evkey.lastIndexOf('.') + 1);
        key = evkey.substr(0, evkey.lastIndexOf('.'));
        entitydata = data.substr(key_end + 1);
        if (entitydata === "?") {
          return this.on_entity_version(null, key, version);
        } else {
          entity = JSON.parse(entitydata);
          return this.on_entity_version(entity['data'], key, version);
        }
      }
    };

    simperium.prototype._notify_client = function(key, new_object, orig_object, diff) {
      var c_object, cursor, element, fieldname, new_data, o_diff, offsets, t_diff, t_object;
      console.log("" + this.listname + ": _notify_client(" + key + ", " + new_object + ", " + orig_object + ", " + (JSON.stringify(diff)) + ")");
      if (!this.cb_get_data) {
        this.cb_notify(key, new_object);
        return;
      }
      c_object = this.cb_get_data(key);
      t_object = null;
      t_diff = null;
      cursor = null;
      offsets = [];
      if (this.jd.typeOf(c_object) === 'array') {
        element = c_object[2];
        fieldname = c_object[1];
        c_object = c_object[0];
        cursor = this._captureCursor(element);
        if (cursor) {
          offsets[0] = cursor['startOffset'];
          if ('endOffset' in cursor) offsets[1] = cursor['endOffset'];
        }
      }
      if ((c_object != null) && (orig_object != null)) {
        o_diff = this.jd.object_diff(orig_object, c_object);
        if (this.jd.entries(o_diff) === 0) {
          t_diff = diff;
          t_object = orig_object;
        } else {
          t_diff = this.jd.transform_object_diff(o_diff, diff, orig_object);
          t_object = new_object;
        }
        if (cursor) {
          new_data = this.jd.apply_object_diff_with_offsets(t_object, t_diff, fieldname, offsets);
          if ((element != null) && 'value' in element) {
            element['value'] = new_data[fieldname];
          }
          cursor['startOffset'] = offsets[0];
          if (offsets.length > 1) {
            cursor['endOffset'] = offsets[1];
            if (cursor['startOffset'] >= cursor['endOffset']) {
              cursor['collapsed'] = true;
            }
          }
          this._restoreCursor(element, cursor);
        } else {
          new_data = this.jd.apply_object_diff(t_object, t_diff);
        }
        return this.cb_notify(key, new_data);
      } else if (new_object) {
        return this.cb_notify(key, new_object);
      } else {
        return this.cb_notify(key, null);
      }
    };

    simperium.prototype._check_update = function(id) {
      var change, found, s_data, _i, _len, _ref;
      if (!(id in this.data.store)) return false;
      s_data = this.data.store[id];
      if (s_data['change']) {
        found = false;
        _ref = this._send_queue;
        for (_i = 0, _len = _ref.length; _i < _len; _i++) {
          change = _ref[_i];
          if (change['id'] === s_data['change']['id'] && change['ccid'] === s_data['change']['ccid']) {
            found = true;
          }
        }
        if (!found) {
          this._queue_change(s_data['change']);
          return true;
        }
        return false;
      }
      if (s_data['check'] != null) return false;
      if ((s_data['last'] != null) && this.jd.entries(s_data['last']) > 0) {
        if (this.jd.equals(s_data['object'], s_data['last'])) {
          s_data['last'] = null;
          this._save_entity(id);
          return false;
        }
      }
      s_data['change'] = this._make_change(id);
      this._queue_change(s_data['change']);
      return true;
    };

    simperium.prototype.update = function(id, object) {
      var s_data,
        _this = this;
      if (!(id != null) && !(object != null)) return false;
      if (!(id != null)) id = this.S4() + this.S4() + this.S4() + this.S4();
      if (!(id in this.data.store)) {
        this.data.store[id] = {
          'id': id,
          'object': {},
          'version': null,
          'change': null,
          'check': null
        };
      }
      s_data = this.data.store[id];
      s_data['last'] = this.jd.deepCopy(object);
      s_data['modified'] = this._time();
      this._save_entity(id);
      console.log("update: " + (JSON.stringify(object)));
      if (!this.sio.connected) return;
      if (s_data['change'] != null) return;
      if (!(s_data['check'] != null)) {
        return s_data['check'] = setTimeout((function(id, s_data) {
          return function() {
            console.log("in delayed running make_change(" + id + ")");
            s_data['check'] = null;
            s_data['change'] = _this._make_change(id);
            s_data['last'] = null;
            _this._save_entity(id);
            return _this._queue_change(s_data['change']);
          };
        })(id, s_data), this.options['update_delay']);
      }
    };

    simperium.prototype._make_change = function(id) {
      var c_object, change, s_data, _i, _len, _ref;
      s_data = this.data.store[id];
      _ref = this._send_queue;
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        change = _ref[_i];
        if (String(id) === change['id']) {
          console.log("" + this.listname + ": _make_change(" + id + ") found pending change, aborting");
          return null;
        }
      }
      change = {
        'id': String(id),
        'ccid': String(this.data.ccid++)
      };
      if (!this.initialized) {
        if (s_data['last'] != null) {
          c_object = s_data['last'];
        } else {
          return null;
        }
      } else {
        if (!this.cb_get_data) {
          if (s_data['last'] != null) {
            c_object = s_data['last'];
          } else {
            return null;
          }
        } else {
          c_object = this.cb_get_data(id);
          if (this.jd.typeOf(c_object) === 'array') c_object = c_object[0];
        }
      }
      if (s_data['version'] != null) change['sv'] = s_data['version'];
      if (c_object === null && (s_data['version'] != null)) {
        change['o'] = '-';
        console.log("" + this.listname + ": DELETION requested for " + id);
      } else if ((c_object != null) && (s_data['object'] != null)) {
        change['o'] = 'M';
        change['v'] = this.jd.object_diff(s_data['object'], c_object);
        if (this.jd.entries(change['v']) === 0) change = null;
      } else {
        change = null;
      }
      return change;
    };

    simperium.prototype._queue_change = function(change) {
      if (!(change != null)) return;
      this._send_queue.push(change);
      if ((this.sio != null) && this.sio.connected) {
        this.sio.send("c:" + (JSON.stringify(change)));
      } else {
        console.log("" + this.listname + ": in queue_change not sending yet");
      }
      if (!(this._send_queue_timer != null)) {
        return this._send_queue_timer = setTimeout(this._send_changes, 10000);
      }
    };

    simperium.prototype._send_changes = function() {
      var change, _i, _len, _ref;
      if (this._send_queue.length === 0) {
        this._send_queue_timer = null;
        return;
      }
      if (!this.sio.connected) {
        this._send_queue_timer = null;
        return;
      }
      _ref = this._send_queue;
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        change = _ref[_i];
        this.sio.send("c:" + (JSON.stringify(change)));
      }
      return this._send_queue_timer = setTimeout(this._send_changes, 10000);
    };

    simperium.prototype.retrieve_changes = function() {
      console.log("" + this.listname + ": requesting changes since cv:" + this.data.last_cv);
      this.sio.send("cv:" + this.data.last_cv);
    };

    simperium.prototype.on_changes = function(response) {
      var change, check_updates, id, new_object, op, orig_object, p, pd, pending, pending_to_delete, reload_needed, s_data, _fn, _i, _j, _k, _l, _len, _len2, _len3, _len4, _ref, _ref2,
        _this = this;
      check_updates = [];
      reload_needed = false;
      console.log("" + this.listname + ": on_changes(): response=");
      console.log(response);
      for (_i = 0, _len = response.length; _i < _len; _i++) {
        change = response[_i];
        console.log("" + this.listname + ": processing id=" + change['id']);
        pending_to_delete = [];
        _ref = this._send_queue;
        for (_j = 0, _len2 = _ref.length; _j < _len2; _j++) {
          pending = _ref[_j];
          if (change['clientid'] === this.clientid && change['id'] === pending['id']) {
            if (('ccid' in change && change['ccid'] === pending['ccid']) || ('ccids' in change && (_ref2 = pending['ccid'], __indexOf.call(change['ccids'], _ref2) >= 0))) {
              change['local'] = true;
              pending_to_delete.push(pending);
              check_updates.push(change['id']);
            }
          }
        }
        for (_k = 0, _len3 = pending_to_delete.length; _k < _len3; _k++) {
          pd = pending_to_delete[_k];
          this.data.store[pd['id']]['change'] = null;
          this._send_queue = (function() {
            var _l, _len4, _ref3, _results;
            _ref3 = this._send_queue;
            _results = [];
            for (_l = 0, _len4 = _ref3.length; _l < _len4; _l++) {
              p = _ref3[_l];
              if (p !== pd) _results.push(p);
            }
            return _results;
          }).call(this);
        }
        if ('error' in change) {
          if (change['error'] === 409) {
            console.log("" + this.listname + ": on_changes(): duplicate change, ignoring");
          } else if (change['error'] === 405) {
            console.log("" + this.listname + ": on_changes(): bad version");
            if (change['id'] in this.data.store) {
              this.data.store[change['id']]['version'] = null;
            }
            reload_needed = true;
          } else {
            console.log("" + this.listname + ": error for last change, reloading");
            if (change['id'] in this.data.store) {
              this.data.store[change['id']]['version'] = null;
            }
            reload_needed = true;
          }
        } else {
          op = change['o'];
          id = change['id'];
          if (op === '-') {
            delete this.data.store[id];
            this._remove_entity(id);
            if (!('local' in change)) {
              this._notify_client(change['id'], null, null, null);
            }
          } else if (op === 'M') {
            s_data = this.data.store[id];
            if (('sv' in change && (s_data != null) && (s_data['version'] != null) && s_data['version'] === change['sv']) || !('sv' in change)) {
              if (!(s_data != null)) {
                this.data.store[id] = {
                  'id': id,
                  'object': {},
                  'version': null,
                  'last': null,
                  'change': null,
                  'check': null
                };
                s_data = this.data.store[id];
              }
              orig_object = this.jd.deepCopy(s_data['object']);
              s_data['object'] = this.jd.apply_object_diff(s_data['object'], change['v']);
              s_data['version'] = change['ev'];
              new_object = this.jd.deepCopy(s_data['object']);
              this._save_entity(id);
              if (!('local' in change)) {
                this._notify_client(change['id'], new_object, orig_object, change['v']);
              }
            } else if ((s_data != null) && (s_data['version'] != null) && change['ev'] <= s_data['version']) {
              console.log("" + this.listname + ": old or duplicate change received, ignoring, change.ev=" + change['ev'] + ", s_data.version:" + s_data['version']);
            } else {
              if (s_data != null) {
                console.log("" + this.listname + ": version mismatch couldnt apply change, change.ev:" + change['ev'] + ", s_data.version:" + s_data['version']);
              } else {
                console.log("" + this.listname + ": version mismatch couldnt apply change, change.ev:" + change['ev'] + ", s_data null");
              }
              if (s_data != null) this.data.store[id]['version'] = null;
              reload_needed = true;
            }
          } else {
            console.log("" + this.listname + ": no operation found for change");
          }
          if (!reload_needed) {
            this.data.last_cv = change['cv'];
            this._save_meta();
            console.log("" + this.listname + ": checkpoint cv=" + this.data.last_cv);
          }
        }
      }
      if (reload_needed) {
        console.log("" + this.listname + ": reload needed, refreshing store");
        setTimeout(function() {
          return _this._refresh_store();
        });
      } else {
        _fn = function(id) {
          return setTimeout((function() {
            return _this._check_update(id);
          }), _this.options['update_delay']);
        };
        for (_l = 0, _len4 = check_updates.length; _l < _len4; _l++) {
          id = check_updates[_l];
          _fn(id);
        }
      }
    };

    simperium.prototype._captureCursor = function(element) {};

    simperium.prototype._captureCursor = function(element) {
        if ('activeElement' in element && !element.activeElement) {
            // Safari specific code.
            // Restoring a cursor in an unfocused element causes the focus to jump.
            return null;
        }
        var padLength = this.dmp.Match_MaxBits / 2;    // Normally 16.
        var text = element.value;
        var cursor = {};
        if ('selectionStart' in element) {    // W3
            try {
                var selectionStart = element.selectionStart;
                var selectionEnd = element.selectionEnd;
            } catch (e) {
                // No cursor; the element may be "display:none".
                return null;
            }
            cursor.startPrefix = text.substring(selectionStart - padLength, selectionStart);
            cursor.startSuffix = text.substring(selectionStart, selectionStart + padLength);
            cursor.startOffset = selectionStart;
            cursor.collapsed = (selectionStart == selectionEnd);
            if (!cursor.collapsed) {
                cursor.endPrefix = text.substring(selectionEnd - padLength, selectionEnd);
                cursor.endSuffix = text.substring(selectionEnd, selectionEnd + padLength);
                cursor.endOffset = selectionEnd;
            }
        } else {    // IE
            // Walk up the tree looking for this textarea's document node.
            var doc = element;
            while (doc.parentNode) {
                doc = doc.parentNode;
            }
            if (!doc.selection || !doc.selection.createRange) {
                // Not IE?
                return null;
            }
            var range = doc.selection.createRange();
            if (range.parentElement() != element) {
                // Cursor not in this textarea.
                return null;
            }
            var newRange = doc.body.createTextRange();

            cursor.collapsed = (range.text == '');
            newRange.moveToElementText(element);
            if (!cursor.collapsed) {
                newRange.setEndPoint('EndToEnd', range);
                cursor.endPrefix = newRange.text;
                cursor.endOffset = cursor.endPrefix.length;
                cursor.endPrefix = cursor.endPrefix.substring(cursor.endPrefix.length - padLength);
            }
            newRange.setEndPoint('EndToStart', range);
            cursor.startPrefix = newRange.text;
            cursor.startOffset = cursor.startPrefix.length;
            cursor.startPrefix = cursor.startPrefix.substring(cursor.startPrefix.length - padLength);

            newRange.moveToElementText(element);
            newRange.setEndPoint('StartToStart', range);
            cursor.startSuffix = newRange.text.substring(0, padLength);
            if (!cursor.collapsed) {
                newRange.setEndPoint('StartToEnd', range);
                cursor.endSuffix = newRange.text.substring(0, padLength);
            }
        }

        // Record scrollbar locations
        if ('scrollTop' in element) {
            cursor.scrollTop = element.scrollTop / element.scrollHeight;
            cursor.scrollLeft = element.scrollLeft / element.scrollWidth;
        }

        // alert(cursor.startPrefix + '|' + cursor.startSuffix + ' ' +
        //         cursor.startOffset + '\n' + cursor.endPrefix + '|' +
        //         cursor.endSuffix + ' ' + cursor.endOffset + '\n' +
        //         cursor.scrollTop + ' x ' + cursor.scrollLeft);
        return cursor;
    };

    simperium.prototype._restoreCursor = function(element, cursor) {};

    simperium.prototype._restoreCursor = function(element, cursor) {
        // Set some constants which tweak the matching behaviour.
        // Maximum distance to search from expected location.
        this.dmp.Match_Distance = 1000;
        // At what point is no match declared (0.0 = perfection, 1.0 = very loose)
        this.dmp.Match_Threshold = 0.9;

        var padLength = this.dmp.Match_MaxBits / 2;    // Normally 16.
        var newText = element.value;

        // Find the start of the selection in the new text.
        var pattern1 = cursor.startPrefix + cursor.startSuffix;
        var pattern2, diff;
        var cursorStartPoint = this.dmp.match_main(newText, pattern1,
                cursor.startOffset - padLength);
        if (cursorStartPoint !== null) {
            pattern2 = newText.substring(cursorStartPoint,
                                                                     cursorStartPoint + pattern1.length);
            //alert(pattern1 + '\nvs\n' + pattern2);
            // Run a diff to get a framework of equivalent indicies.
            diff = this.dmp.diff_main(pattern1, pattern2, false);
            cursorStartPoint += this.dmp.diff_xIndex(diff, cursor.startPrefix.length);
        }

        var cursorEndPoint = null;
        if (!cursor.collapsed) {
            // Find the end of the selection in the new text.
            pattern1 = cursor.endPrefix + cursor.endSuffix;
            cursorEndPoint = this.dmp.match_main(newText, pattern1,
                    cursor.endOffset - padLength);
            if (cursorEndPoint !== null) {
                pattern2 = newText.substring(cursorEndPoint,
                                                                         cursorEndPoint + pattern1.length);
                //alert(pattern1 + '\nvs\n' + pattern2);
                // Run a diff to get a framework of equivalent indicies.
                diff = this.dmp.diff_main(pattern1, pattern2, false);
                cursorEndPoint += this.dmp.diff_xIndex(diff, cursor.endPrefix.length);
            }
        }

        // Deal with loose ends
        if (cursorStartPoint === null && cursorEndPoint !== null) {
            // Lost the start point of the selection, but we have the end point.
            // Collapse to end point.
            cursorStartPoint = cursorEndPoint;
        } else if (cursorStartPoint === null && cursorEndPoint === null) {
            // Lost both start and end points.
            // Jump to the offset of start.
            cursorStartPoint = cursor.startOffset;
        }
        if (cursorEndPoint === null) {
            // End not known, collapse to start.
            cursorEndPoint = cursorStartPoint;
        }

        // Restore selection.
        if ('selectionStart' in element) {    // W3
            element.selectionStart = cursorStartPoint;
            element.selectionEnd = cursorEndPoint;
        } else {    // IE
            // Walk up the tree looking for this textarea's document node.
            var doc = element;
            while (doc.parentNode) {
                doc = doc.parentNode;
            }
            if (!doc.selection || !doc.selection.createRange) {
                // Not IE?
                return;
            }
            // IE's TextRange.move functions treat '\r\n' as one character.
            var snippet = element.value.substring(0, cursorStartPoint);
            var ieStartPoint = snippet.replace(/\r\n/g, '\n').length;

            var newRange = doc.body.createTextRange();
            newRange.moveToElementText(element);
            newRange.collapse(true);
            newRange.moveStart('character', ieStartPoint);
            if (!cursor.collapsed) {
                snippet = element.value.substring(cursorStartPoint, cursorEndPoint);
                var ieMidLength = snippet.replace(/\r\n/g, '\n').length;
                newRange.moveEnd('character', ieMidLength);
            }
            newRange.select();
        }

        // Restore scrollbar locations
        if ('scrollTop' in cursor) {
            element.scrollTop = cursor.scrollTop * element.scrollHeight;
            element.scrollLeft = cursor.scrollLeft * element.scrollWidth;
        }
    };

    return simperium;

  })();

  window['Simperium'] = simperium;

  simperium.prototype['set_notify'] = simperium.prototype.set_notify;

  simperium.prototype['set_notify_version'] = simperium.prototype.set_notify_version;

  simperium.prototype['set_get_data'] = simperium.prototype.set_get_data;

  simperium.prototype['set_initialized'] = simperium.prototype.set_initialized;

  simperium.prototype['get_all_data'] = simperium.prototype.get_all_data;

  simperium.prototype['start'] = simperium.prototype.start;

  simperium.prototype['initialize_client'] = simperium.prototype.initialize_client;

  simperium.prototype['login'] = simperium.prototype.login;

  simperium.prototype['load_versions'] = simperium.prototype.load_versions;

}).call(this);
