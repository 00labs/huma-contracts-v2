// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditLine} from "../CreditLine.sol";
import {CreditConfig, CreditRecord} from "../CreditStructs.sol";
import {Errors} from "../../Errors.sol";

//* Reserved for Richard review, to be deleted
// This is not in V2 scope

contract DynamicYieldCredit is CreditLine {
    function getEstimatedYield(address borrower) external view returns (uint256 yieldInBps) {
        return uint256(_getCreditConfig(getCreditHash(borrower)).yieldInBps);
    }

    function declareYield(address borrower, uint256 yieldInBps) public virtual {
        _onlyBorrowerOrEAServiceAccount(borrower);
        if (yieldInBps == 0) revert Errors.todo();

        _creditConfigMap[getCreditHash(borrower)].yieldInBps = uint16(yieldInBps);
    }
}
