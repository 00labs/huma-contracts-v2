// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig, ReceivableInfo} from "../../CreditStructs.sol";

//* Reserved for Richard review, to be deleted
// This is not in V2 scope?

interface ICreditFacility {
    function addReceivable(address borrower, uint256 receivableId) external;

    function declarePayment(address borrower, uint256 receivableId, uint256 amount) external;
}