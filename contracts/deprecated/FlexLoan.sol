// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ReceivableFactoring} from "../credit/ReceivableFactoring.sol";

contract FlexLoan is ReceivableFactoring {
    address public borrower;

    function submitWithdrawalRequest() external {
        // record withdrawal request
        // send an event
    }
}
