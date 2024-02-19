// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

contract Utils {
    function _toToken(uint256 amount, uint256 decimals) internal pure returns (uint256) {
        return amount * 10 ** decimals;
    }

    function _boundNew(
        uint256 x,
        uint256 min,
        uint256 max
    ) internal pure returns (uint256 result) {
        require(min <= max, "StdUtils bound(uint256,uint256,uint256): Max is less than min.");
        // If x is between min and max, return x directly. This is to ensure that dictionary values
        // do not get shifted if the min is nonzero. More info: https://github.com/foundry-rs/forge-std/issues/188
        if (x >= min && x <= max) return x;

        uint256 size = max - min + 1;

        if (x < min) {
            x = x + min;
        }

        // Otherwise, wrap x into the range [min, max], i.e. the range is inclusive.
        if (x > max) {
            uint256 diff = x - max;
            uint256 rem = diff % size;
            if (rem == 0) return max;
            result = min + rem - 1;
        } else {
            result = x;
        }
    }
}
