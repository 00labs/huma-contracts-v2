// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;


contract DynamicYieldCredit {
    
    function approve() public {

    }

    function drawdown() public virtual returns (uint96 amount) {
    }

    function declareYield() public virtual returns (uint96 yield){
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
    }

    function getHashCode() public virtual returns (bytes32 creditHash) {
    }
}
